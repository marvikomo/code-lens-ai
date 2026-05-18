import type { SyntaxNode } from "tree-sitter";
import type { GraphBuilder, GraphNode, SourceRange } from "../util/graph";
import type { SupportedLanguage } from "../util/language";

export interface ExtractContext {
  builder: GraphBuilder;
  fileNode: GraphNode;
  filePath: string;
  language: SupportedLanguage;
  /** Pending unresolved imports: raw module specifier → list of "files we should link to". Resolved at the end. */
  pendingImports: {
    from: string;
    spec: string;
    reexport?:
      | { kind: "named"; localName: string; exportedName: string }
      | { kind: "all" };
  }[];
}

export interface LanguageExtractor {
  extract(root: SyntaxNode, ctx: ExtractContext): void;
}

export function rangeOf(n: SyntaxNode): SourceRange {
  return {
    start: { row: n.startPosition.row, column: n.startPosition.column },
    end: { row: n.endPosition.row, column: n.endPosition.column },
  };
}

/** Walk all named descendants depth-first, invoking `visit`.  Returning `false` skips children. */
export function walk(
  node: SyntaxNode,
  visit: (n: SyntaxNode) => boolean | void,
): void {
  const cont = visit(node);
  if (cont === false) return;
  for (const child of node.namedChildren) walk(child, visit);
}

/** Get text of a child field if it exists. */
export function fieldText(n: SyntaxNode, name: string): string | undefined {
  return n.childForFieldName(name)?.text;
}

/** Soft cap on stored node bodies. Larger nodes are truncated, not dropped. */
export const MAX_BODY_BYTES = 50_000;

/**
 * Spreadable fields for a node's body. Truncates at a newline boundary near
 * the cap when the source exceeds `max`, and sets `bodyTruncated: true` so
 * downstream consumers (FTS, embeddings, MCP tools) know the content is partial.
 *
 * Returns `{}` only for empty/zero-length nodes.
 */
export function bodyFields(
  n: SyntaxNode,
  max = MAX_BODY_BYTES,
): { body?: string; bodyTruncated?: true } {
  const len = n.endIndex - n.startIndex;
  if (len <= 0) return {};
  if (len <= max) return { body: n.text };

  // Truncate at the last newline in the upper portion of the slice for a
  // readable cut. Fall back to a hard cut if no newline is found near the end.
  const slice = n.text.slice(0, max);
  const lastNewline = slice.lastIndexOf("\n");
  const body = lastNewline > max * 0.8 ? slice.slice(0, lastNewline) : slice;
  return { body, bodyTruncated: true };
}

/**
 * AST-based test-file detection for JS/TS/TSX. Walks the root looking for:
 *   - call_expression with callee `describe` / `it` / `test` / `xdescribe` /
 *     `xit` / `bench` / `suite` / `beforeEach` / `afterEach`
 *   - import_statement whose source is jest/vitest/bun:test
 *
 * Returns the detected framework name or null. Stops scanning early once a
 * confident match is found (single positive call_expression OR import).
 */
export function detectJsTestFile(root: SyntaxNode): string | null {
  const TEST_FNS = new Set([
    "describe",
    "it",
    "test",
    "xdescribe",
    "xit",
    "xtest",
    "fdescribe",
    "fit",
    "bench",
    "suite",
  ]);
  const FRAMEWORKS: Record<string, string> = {
    vitest: "vitest",
    "bun:test": "bun",
    jest: "jest",
    "@jest/globals": "jest",
    mocha: "mocha",
  };

  // Two passes so imports get to refine the framework name. Without this, a
  // stack-based DFS that hits `describe(...)` first would lock in "jest" as
  // the default before reaching the actual `import { describe } from "vitest"`.
  let importFramework: string | null = null;
  let hasTestCall = false;
  const stack: SyntaxNode[] = [root];
  let nodesVisited = 0;
  const HARD_LIMIT = 5000;

  while (stack.length) {
    if (nodesVisited++ > HARD_LIMIT) break;
    const n = stack.pop()!;

    if (n.type === "import_statement" || n.type === "import_declaration") {
      const src = n.childForFieldName("source");
      const text = src?.text?.replace(/^["'`]|["'`]$/g, "") ?? "";
      if (FRAMEWORKS[text]) {
        importFramework = FRAMEWORKS[text];
        // Imports are authoritative for framework. Stop scanning.
        return importFramework;
      }
    }

    if (!hasTestCall && n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      const name = fn?.text;
      if (name && TEST_FNS.has(name)) {
        hasTestCall = true;
      }
    }

    for (const c of n.namedChildren) stack.push(c);
  }

  // No framework import found, but test calls present → default to jest.
  return hasTestCall ? "jest" : null;
}

/**
 * AST-based test detection for Java files. Looks for `@Test` annotation on
 * any method declaration (covers JUnit 4, JUnit 5, TestNG).
 */
export function detectJavaTestFile(root: SyntaxNode): string | null {
  const stack: SyntaxNode[] = [root];
  let nodesVisited = 0;
  const HARD_LIMIT = 5000;

  while (stack.length) {
    if (nodesVisited++ > HARD_LIMIT) break;
    const n = stack.pop()!;
    if (n.type === "marker_annotation" || n.type === "annotation") {
      // tree-sitter-java surfaces @Test as marker_annotation with name child
      const nameChild = n.namedChildren.find((c) => c.type === "identifier");
      if (nameChild?.text === "Test") {
        return "junit";
      }
    }
    for (const c of n.namedChildren) stack.push(c);
  }

  return null;
}

/**
 * Path-based test detection — fallback for files we couldn't parse, or as a
 * defensive secondary signal. Covers conventions across JS/TS/Java/Go/Python.
 */
export function isTestPath(path: string): boolean {
  return (
    /(\.test\.|\.spec\.)[a-z]+$/i.test(path) ||
    /[/\\]__tests__[/\\]/i.test(path) ||
    /[/\\](test|tests|__test__|spec)[/\\]/i.test(path) ||
    /_test\.(go|py)$/i.test(path) ||
    /test_[^/\\]+\.py$/i.test(path) ||
    /[/\\]src[/\\]test[/\\]/i.test(path)
  );
}

/**
 * Declaration text up to the body — for callables/classes that have a body
 * field. For nodes without a body (TypeAlias, Enum, Property), returns the
 * full text. Returned strings are trimmed of trailing whitespace only.
 */
export function signatureOf(n: SyntaxNode): string {
  const body = n.childForFieldName("body");
  if (body) {
    const offset = body.startIndex - n.startIndex;
    if (offset > 0 && offset <= n.text.length) {
      return n.text.slice(0, offset).trimEnd();
    }
  }
  return n.text.trimEnd();
}
