import type { SyntaxNode } from "tree-sitter";
import {
  ExtractContext,
  LanguageExtractor,
  rangeOf,
  bodyFields,
  isTestPath,
} from "./base";
import {
  CONFIG_DEFAULTS,
  DeclKind,
  LanguageConfig,
  simpleTypeName,
} from "./language-config";
import type { GraphNode, NodeKind } from "../util/graph";

/**
 * One walker, driven by a `LanguageConfig`, standing in for the hand-written
 * per-language extractor that JS/TS and Java still get.
 *
 * Ported from graphify's config-driven engine (graphify/extractors/engine.py).
 * The trade is deliberate: this path models the shape every language shares —
 * types, functions, methods, properties, imports, calls, inheritance — and
 * nothing language-specific. Anything richer (HTTP routes, export/re-export
 * graphs) stays in the bespoke extractors.
 */
export class GenericExtractor implements LanguageExtractor {
  constructor(private readonly config: LanguageConfig) {}

  extract(root: SyntaxNode, ctx: ExtractContext): void {
    const framework =
      this.config.testDetector?.(root) ??
      (isTestPath(ctx.filePath) ? "unknown" : null);
    if (framework) {
      ctx.fileNode.isTest = true;
      ctx.fileNode.testFramework = framework;
    }
    this.visit(root, ctx);
  }

  // ------------------------------------------------------------------ walking

  private visit(node: SyntaxNode, ctx: ExtractContext): void {
    const kind = this.classify(node);

    switch (kind) {
      case "Skip":
        return;
      case "Import":
        this.handleImport(node, ctx);
        return;
      case "Class":
      case "Interface":
        this.handleType(node, ctx, kind);
        return;
      case "Enum":
      case "TypeAlias":
        this.handleLeafType(node, ctx, kind);
        return;
      case "Function":
      case "Method":
        // A bare function at file scope. Methods reach the graph through
        // `collectMembers`, but a config may classify one here (Objective-C
        // keeps method definitions outside the @interface body).
        this.handleFunction(node, ctx, null);
        return;
    }

    if (this.config.extraVisit?.(node, ctx) === true) return;

    for (const child of node.namedChildren) this.visit(child, ctx);
  }

  /** Config hook first, then the node-type tables. */
  private classify(node: SyntaxNode): DeclKind | undefined {
    const fromHook = this.config.classify?.(node);
    if (fromHook) return fromHook;

    const t = node.type;
    if (this.config.importTypes.includes(t)) return "Import";
    if (this.config.classTypes.includes(t)) return "Class";
    if (this.config.interfaceTypes.includes(t)) return "Interface";
    if (this.config.enumTypes.includes(t)) return "Enum";
    if (this.config.typeAliasTypes.includes(t)) return "TypeAlias";
    if (this.config.functionTypes.includes(t)) return "Function";
    return undefined;
  }

  // ------------------------------------------------------------- declarations

  private handleImport(node: SyntaxNode, ctx: ExtractContext): void {
    const spec = this.config.importSpec
      ? this.config.importSpec(node)
      : defaultImportSpec(node);
    if (spec) ctx.pendingImports.push({ from: ctx.fileNode.id, spec });
  }

  private handleType(
    node: SyntaxNode,
    ctx: ExtractContext,
    kind: "Class" | "Interface",
  ): void {
    const name = this.nameOf(node);
    const typeNode = this.addNode(node, ctx, {
      id: `${ctx.fileNode.id}#${kind.toLowerCase()}:${name}`,
      kind,
      name,
    });
    ctx.builder.addEdge({
      kind: "DEFINES",
      from: ctx.fileNode.id,
      to: typeNode.id,
    });
    this.exportIfVisible(node, typeNode, ctx);

    this.handleHeritage(node, typeNode, ctx);

    // Several grammars hang members straight off the declaration with no body
    // wrapper at all (PowerShell `class_statement`, Objective-C
    // `class_interface`). Falling back to the node keeps those languages from
    // producing types with no members.
    this.collectMembers(this.bodyOf(node) ?? node, typeNode, ctx);
  }

  /** Enums and type aliases: a node and a DEFINES edge, no members. */
  private handleLeafType(
    node: SyntaxNode,
    ctx: ExtractContext,
    kind: "Enum" | "TypeAlias",
  ): void {
    const name = this.nameOf(node);
    const suffix = kind === "Enum" ? "enum" : "type";
    const typeNode = this.addNode(node, ctx, {
      id: `${ctx.fileNode.id}#${suffix}:${name}`,
      kind,
      name,
    });
    ctx.builder.addEdge({
      kind: "DEFINES",
      from: ctx.fileNode.id,
      to: typeNode.id,
    });
    this.exportIfVisible(node, typeNode, ctx);
  }

  /**
   * A function or method. `owner` non-null makes it a Method hanging off that
   * type; otherwise it is a file-level Function.
   *
   * Nested declarations inside the body are still walked, so an inner class or
   * closure gets its own node rather than disappearing into its parent's body.
   */
  private handleFunction(
    node: SyntaxNode,
    ctx: ExtractContext,
    owner: GraphNode | null,
  ): void {
    const name = this.nameOf(node);
    const kind: NodeKind = owner ? "Method" : "Function";
    const id = owner
      ? `${owner.id}.method:${name}@${node.startPosition.row}`
      : `${ctx.fileNode.id}#fn:${name}@${node.startPosition.row}`;

    const fnNode = this.addNode(node, ctx, { id, kind, name });
    ctx.builder.addEdge(
      owner
        ? { kind: "HAS_METHOD", from: owner.id, to: fnNode.id }
        : { kind: "DEFINES", from: ctx.fileNode.id, to: fnNode.id },
    );
    // Only file-level declarations are importable; a method is reached
    // through its owner, not by name from another file.
    if (!owner) this.exportIfVisible(node, fnNode, ctx);

    const callScope =
      this.config.callScope === "body" ? this.bodyOf(node) : node;
    if (callScope) this.collectCalls(callScope, fnNode, ctx);

    // Descend for nested declarations only — the calls above already covered
    // this scope, and `collectCalls` stopped at nested function boundaries.
    const body = this.bodyOf(node);
    if (body) {
      for (const child of body.namedChildren) this.visit(child, ctx);
    }
  }

  /**
   * Record a file-level declaration as importable.
   *
   * Without these edges the resolver's import-aware path cannot fire at all
   * and every cross-file call falls back to matching on bare name — which is
   * exactly what happened for every language except JS/TS.
   */
  private exportIfVisible(
    node: SyntaxNode,
    declaration: GraphNode,
    ctx: ExtractContext,
  ): void {
    if (declaration.name === ANONYMOUS) return;
    const visible = this.config.isExported
      ? this.config.isExported(node, declaration.name)
      : true;
    if (!visible) return;
    ctx.builder.addEdge({
      kind: "EXPORTS",
      from: ctx.fileNode.id,
      to: declaration.id,
      meta: { exportedName: declaration.name },
    });
  }

  private handleProperty(
    node: SyntaxNode,
    owner: GraphNode,
    ctx: ExtractContext,
  ): void {
    const name = this.nameOf(node);
    if (name === ANONYMOUS) return;
    const propNode = this.addNode(node, ctx, {
      id: `${owner.id}.prop:${name}`,
      kind: "Property",
      name,
    });
    ctx.builder.addEdge({
      kind: "HAS_PROPERTY",
      from: owner.id,
      to: propNode.id,
    });
  }

  /**
   * Find members inside a type body, descending through whatever wrapper nodes
   * a grammar puts in the way (`block`, `declaration_list`, `template_body`,
   * `type_body_intended`, …) rather than enumerating them per language.
   * Descent stops at anything that is itself a declaration.
   */
  private collectMembers(
    body: SyntaxNode,
    owner: GraphNode,
    ctx: ExtractContext,
  ): void {
    for (const child of body.namedChildren) {
      const t = child.type;

      if (
        this.config.methodTypes.includes(t) ||
        this.config.functionTypes.includes(t)
      ) {
        this.handleFunction(child, ctx, owner);
        continue;
      }
      if (this.config.propertyTypes.includes(t)) {
        this.handleProperty(child, owner, ctx);
        continue;
      }

      const kind = this.classify(child);
      if (kind === "Skip") continue;
      if (kind && kind !== "Import") {
        // A nested type: hand it back to the main walk so it is DEFINED on the
        // file, matching how the Java extractor treats inner classes.
        this.visit(child, ctx);
        continue;
      }

      this.collectMembers(child, owner, ctx);
    }
  }

  // ------------------------------------------------------------------ heritage

  private handleHeritage(
    node: SyntaxNode,
    typeNode: GraphNode,
    ctx: ExtractContext,
  ): void {
    const emit = (raw: string, edge: "EXTENDS" | "IMPLEMENTS"): void => {
      const symbol = simpleTypeName(raw);
      if (!symbol) return;
      ctx.builder.addEdge({
        kind: edge,
        from: typeNode.id,
        to: `unresolved:${edge === "EXTENDS" ? "class" : "interface"}:${symbol}`,
        source: "name_only",
        unresolved: symbol,
      });
    };

    const collect = (
      fields: readonly string[] | undefined,
      childTypes: readonly string[] | undefined,
      edge: "EXTENDS" | "IMPLEMENTS",
    ): void => {
      for (const field of fields ?? []) {
        const held = node.childForFieldName(field);
        if (!held) continue;
        // The clause node usually wraps the type references; when it has named
        // children treat those as the types, else use the clause text itself.
        if (held.namedChildCount > 0) {
          for (const t of held.namedChildren) emit(t.text, edge);
        } else {
          emit(held.text, edge);
        }
      }
      for (const child of node.namedChildren) {
        if (!(childTypes ?? []).includes(child.type)) continue;
        if (child.namedChildCount > 0) {
          for (const t of child.namedChildren) emit(t.text, edge);
        } else {
          emit(child.text, edge);
        }
      }
    };

    collect(this.config.extendsFields, this.config.extendsChildTypes, "EXTENDS");
    collect(
      this.config.implementsFields,
      this.config.implementsChildTypes,
      "IMPLEMENTS",
    );
  }

  // --------------------------------------------------------------------- calls

  /**
   * Emit CALLS for every call site in `scope`, stopping at nested function
   * boundaries so a closure's calls are attributed to the closure and not to
   * the function that contains it.
   */
  private collectCalls(
    scope: SyntaxNode,
    enclosing: GraphNode,
    ctx: ExtractContext,
  ): void {
    const boundaries = this.config.functionBoundaryTypes ?? [];

    const walkCalls = (node: SyntaxNode, isRoot: boolean): void => {
      if (!isRoot && boundaries.includes(node.type)) return;

      if (this.config.callTypes.includes(node.type)) {
        const callee = this.calleeOf(node);
        if (callee && !this.isFilteredBuiltin(node, callee)) {
          ctx.builder.addEdge({
            kind: "CALLS",
            from: enclosing.id,
            to: `unresolved:callable:${callee.name}`,
            source: "name_only",
            unresolved: callee.name,
          });
        }
      }

      for (const child of node.namedChildren) walkCalls(child, false);
    };

    walkCalls(scope, true);
  }

  /**
   * Resolve a call site to a callee name, and report whether it arrived through
   * a receiver (`obj.meth()`) or as a bare identifier (`meth()`).
   */
  private calleeOf(
    node: SyntaxNode,
  ): { name: string; viaAccessor: boolean } | undefined {
    const custom = this.config.resolveCallee?.(node);
    if (custom) {
      return { name: custom, viaAccessor: custom !== node.text };
    }

    const field = this.config.callFunctionField ?? CONFIG_DEFAULTS.callFunctionField;
    const target = node.childForFieldName(field) ?? node.namedChild(0);
    if (!target) return undefined;

    const accessors = this.config.callAccessorTypes ?? [];
    if (accessors.includes(target.type)) {
      const accessorField =
        this.config.callAccessorField ?? CONFIG_DEFAULTS.callAccessorField;
      // Fall back to the last named child: across grammars the member name is
      // the trailing child of an accessor, so this keeps working even where the
      // field is spelled differently (`field` vs `name` vs `attribute`).
      const member =
        target.childForFieldName(accessorField) ??
        target.namedChild(target.namedChildCount - 1);
      const name = member ? simpleIdentifier(member.text) : undefined;
      return name ? { name, viaAccessor: true } : undefined;
    }

    const name = simpleIdentifier(target.text);
    return name ? { name, viaAccessor: target.text !== name } : undefined;
  }

  /**
   * Drop a builtin only when it was called as a bare identifier.
   *
   * The bare-identifier restriction is the whole point: `append(x)` in Go is a
   * builtin, but `h.append(x)` is a real method on a receiver. graphify found
   * this the hard way — filtering both spellings silently deletes genuine
   * edges, filtering neither lets one method named `append` swallow hundreds of
   * phantom callers.
   */
  private isFilteredBuiltin(
    node: SyntaxNode,
    callee: { name: string; viaAccessor: boolean },
  ): boolean {
    if (callee.viaAccessor) return false;
    return (this.config.builtinCallNames ?? []).includes(callee.name);
  }

  // ------------------------------------------------------------------- helpers

  private addNode(
    node: SyntaxNode,
    ctx: ExtractContext,
    fields: { id: string; kind: NodeKind; name: string },
  ): GraphNode {
    return ctx.builder.addNode({
      ...fields,
      path: ctx.filePath,
      language: ctx.language,
      range: rangeOf(node),
      signature: this.signatureOf(node),
      ...bodyFields(node),
    });
  }

  private nameOf(node: SyntaxNode): string {
    const custom = this.config.resolveName?.(node);
    if (custom) return custom;

    const field = this.config.nameField ?? CONFIG_DEFAULTS.nameField;
    const named = node.childForFieldName(field);
    if (named?.text) return named.text;

    for (const type of this.config.nameFallbackTypes ?? []) {
      const child = node.namedChildren.find((c) => c.type === type);
      if (child?.text) return child.text;
    }
    return ANONYMOUS;
  }

  private bodyOf(node: SyntaxNode): SyntaxNode | null {
    const field = this.config.bodyField ?? CONFIG_DEFAULTS.bodyField;
    const body = node.childForFieldName(field);
    if (body) return body;

    for (const type of this.config.bodyFallbackTypes ?? []) {
      const child = node.namedChildren.find((c) => c.type === type);
      if (child) return child;
    }
    return null;
  }

  /**
   * Declaration text up to the body. `base.signatureOf` assumes the body lives
   * on a field literally called "body", which only holds for some grammars, so
   * the body node is resolved through the config here.
   */
  private signatureOf(node: SyntaxNode): string {
    const body = this.bodyOf(node);
    if (body) {
      const offset = body.startIndex - node.startIndex;
      if (offset > 0 && offset <= node.text.length) {
        return node.text.slice(0, offset).trimEnd();
      }
    }
    return node.text.trimEnd();
  }
}

const ANONYMOUS = "<anonymous>";

/** Trailing segment of a dotted / scoped / arrow-dereferenced name. */
function simpleIdentifier(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const segments = trimmed.split(/::|->|[.\\]/);
  const last = segments[segments.length - 1]?.trim();
  if (!last) return undefined;
  return /^[A-Za-z_$@][\w$-]*$/.test(last) ? last : undefined;
}

/**
 * Best-effort module specifier when a config supplies no `importSpec`: prefer a
 * string literal (`import "fmt"`), else a dotted/scoped identifier
 * (`import a.b.C`), else the statement text minus its keyword.
 */
function defaultImportSpec(node: SyntaxNode): string | undefined {
  const stringish = node.descendantsOfType([
    "string_literal",
    "interpreted_string_literal",
    "string",
    "string_content",
    "string_fragment",
  ])[0];
  if (stringish?.text) return stripQuotes(stringish.text);

  const dotted = node.namedChildren.find((c) =>
    [
      "dotted_name",
      "scoped_identifier",
      "qualified_name",
      "namespace_name",
      "identifier",
      "module_path",
      "module_name",
    ].includes(c.type),
  );
  if (dotted?.text) return dotted.text.trim();

  const text = node.text.trim();
  return text ? text.replace(/^\s*\w+\s+/, "").replace(/;$/, "").trim() : undefined;
}

function stripQuotes(raw: string): string {
  return raw.replace(/^["'`]|["'`]$/g, "").trim();
}
