import type { SyntaxNode } from "tree-sitter";
import {
  ExtractContext,
  LanguageExtractor,
  rangeOf,
  fieldText,
  bodyFields,
  signatureOf,
  detectJavaTestFile,
  isTestPath,
} from "./base";
import type { GraphNode } from "../util/graph";

/**
 * Extractor for tree-sitter-java.
 * Handles classes, interfaces, methods, fields, imports, extends/implements
 * and method invocations (CALLS).
 */
export class JavaExtractor implements LanguageExtractor {
  extract(root: SyntaxNode, ctx: ExtractContext): void {
    const framework =
      detectJavaTestFile(root) ?? (isTestPath(ctx.filePath) ? "unknown" : null);
    if (framework) {
      ctx.fileNode.isTest = true;
      ctx.fileNode.testFramework = framework;
    }

    this.visit(root, ctx);
  }

  private visit(node: SyntaxNode, ctx: ExtractContext): void {
    switch (node.type) {
      case "import_declaration": {
        // `import a.b.c.Foo;` or `import a.b.*;`
        const inner = node.namedChildren.find(
          (c) => c.type === "scoped_identifier" || c.type === "identifier",
        );
        const spec = (inner ?? node).text.replace(/;$/, "").trim();
        ctx.pendingImports.push({ from: ctx.fileNode.id, spec });
        return;
      }

      case "class_declaration": {
        const cls = this.makeClass(node, ctx, "Class");
        ctx.builder.addEdge({
          kind: "DEFINES",
          from: ctx.fileNode.id,
          to: cls.id,
        });
        this.exportType(cls, ctx);
        this.handleHeritage(node, cls, ctx);
        const body = node.childForFieldName("body");
        if (body) {
          for (const member of body.namedChildren) {
            this.handleClassMember(member, cls, ctx);
          }
        }
        return;
      }

      case "interface_declaration": {
        const iface = this.makeClass(node, ctx, "Interface");
        ctx.builder.addEdge({
          kind: "DEFINES",
          from: ctx.fileNode.id,
          to: iface.id,
        });
        this.exportType(iface, ctx);
        // Interface bodies contain method signatures; treat as methods.
        const body = node.childForFieldName("body");
        if (body) {
          for (const member of body.namedChildren) {
            this.handleClassMember(member, iface, ctx);
          }
        }
        return;
      }
    }

    for (const child of node.namedChildren) {
      this.visit(child, ctx);
    }
  }

  /**
   * A Java type is importable by its `package.Type` name, so record it as an
   * export. Without this the resolver has no import-aware path for Java and
   * binds every cross-file reference by bare name.
   */
  private exportType(type: GraphNode, ctx: ExtractContext): void {
    if (type.name === "<anonymous>") return;
    ctx.builder.addEdge({
      kind: "EXPORTS",
      from: ctx.fileNode.id,
      to: type.id,
      meta: { exportedName: type.name },
    });
  }

  private makeClass(
    node: SyntaxNode,
    ctx: ExtractContext,
    kind: "Class" | "Interface",
  ): GraphNode {
    const name = fieldText(node, "name") ?? "<anonymous>";
    const id = `${ctx.fileNode.id}#${kind.toLowerCase()}:${name}`;
    return ctx.builder.addNode({
      id,
      kind,
      name,
      path: ctx.filePath,
      language: ctx.language,
      range: rangeOf(node),
      signature: signatureOf(node),
      ...bodyFields(node),
    });
  }

  private handleHeritage(
    node: SyntaxNode,
    cls: GraphNode,
    ctx: ExtractContext,
  ): void {
    const sup = node.childForFieldName("superclass");
    if (sup) {
      // `superclass` field wraps `extends X`; the type itself is a child.
      for (const t of sup.namedChildren) {
        const symbol = t.text;
        ctx.builder.addEdge({
          kind: "EXTENDS",
          from: cls.id,
          to: `unresolved:class:${symbol}`,
          source: "name_only",
          unresolved: symbol,
        });
      }
    }
    const interfaces = node.childForFieldName("interfaces");
    if (interfaces) {
      for (const list of interfaces.namedChildren) {
        // `interfaces` -> `super_interfaces` -> `type_list`
        for (const t of list.namedChildren) {
          const symbol = t.text;
          ctx.builder.addEdge({
            kind: "IMPLEMENTS",
            from: cls.id,
            to: `unresolved:interface:${symbol}`,
            source: "name_only",
            unresolved: symbol,
          });
        }
      }
    }
  }

  private handleClassMember(
    member: SyntaxNode,
    cls: GraphNode,
    ctx: ExtractContext,
  ): void {
    switch (member.type) {
      case "method_declaration": {
        const name = fieldText(member, "name") ?? "<anonymous>";
        const id = `${cls.id}.method:${name}@${member.startPosition.row}`;
        const m = ctx.builder.addNode({
          id,
          kind: "Method",
          name,
          path: ctx.filePath,
          language: ctx.language,
          range: rangeOf(member),
          signature: signatureOf(member),
          ...bodyFields(member),
        });
        ctx.builder.addEdge({ kind: "HAS_METHOD", from: cls.id, to: m.id });
        this.collectCalls(member, m, ctx);
        return;
      }
      case "field_declaration": {
        // A field_declaration may declare multiple variables.
        const declarators = member.descendantsOfType("variable_declarator");
        for (const d of declarators) {
          const nameNode = d.childForFieldName("name") ?? d.namedChild(0);
          const name = nameNode?.text ?? "<anonymous>";
          const id = `${cls.id}.prop:${name}`;
          const p = ctx.builder.addNode({
            id,
            kind: "Property",
            name,
            path: ctx.filePath,
            language: ctx.language,
            range: rangeOf(member),
            signature: signatureOf(member),
            ...bodyFields(member),
          });
          ctx.builder.addEdge({ kind: "HAS_PROPERTY", from: cls.id, to: p.id });
        }
        return;
      }
      // Inner classes/interfaces – recurse so they get DEFINED on the file.
      case "class_declaration":
      case "interface_declaration":
        this.visit(member, ctx);
        return;
    }
  }

  private collectCalls(
    node: SyntaxNode,
    enclosing: GraphNode,
    ctx: ExtractContext,
  ): void {
    for (const call of node.descendantsOfType("method_invocation")) {
      const nameNode = call.childForFieldName("name");
      const symbol = nameNode?.text;
      if (!symbol) continue;
      ctx.builder.addEdge({
        kind: "CALLS",
        from: enclosing.id,
        to: `unresolved:callable:${symbol}`,
        source: "name_only",
        unresolved: symbol,
      });
    }
    // Constructor calls: `new Foo()`
    for (const call of node.descendantsOfType("object_creation_expression")) {
      const t = call.childForFieldName("type");
      const symbol = t?.text;
      if (!symbol) continue;
      ctx.builder.addEdge({
        kind: "CALLS",
        from: enclosing.id,
        to: `unresolved:callable:${symbol}`,
        source: "name_only",
        unresolved: symbol,
      });
    }
  }
}
