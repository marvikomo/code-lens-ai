import type { SyntaxNode } from "tree-sitter";
import type { ExtractContext } from "./base";

/**
 * What the walker decided a node declares. "Import" and "Skip" are control
 * outcomes rather than graph node kinds.
 */
export type DeclKind =
  | "Class"
  | "Interface"
  | "Enum"
  | "TypeAlias"
  | "Function"
  | "Method"
  | "Property"
  | "Import"
  | "Skip";

/**
 * Declarative description of how to read declarations out of one language's
 * tree-sitter CST.
 *
 * The pattern is borrowed from graphify's `LanguageConfig` dataclass
 * (graphify/extractors/models.py): one generic walker consumes a per-language
 * table of node-type names instead of every language getting a hand-written
 * walker. That is what makes the language count scale — adding a language is
 * normally a config object, not a new extractor class.
 *
 * The bespoke `JsTsExtractor` and `JavaExtractor` stay as they are. They emit
 * things this generic path deliberately does not model (HTTP routes, exports,
 * re-exports, anonymous handler functions), and downgrading them to configs
 * would lose signal.
 */
export interface LanguageConfig {
  /** Stable key, also used as `GraphNode.language`. */
  readonly id: string;

  /** npm package providing the grammar, e.g. "tree-sitter-go". */
  readonly grammarModule: string;

  /**
   * Property to read off the grammar module for packages that ship several
   * grammars (`tree-sitter-typescript` → `typescript` / `tsx`,
   * `tree-sitter-php` → `php`, `tree-sitter-ocaml` → `ocaml`).
   * Omitted when the module itself is the language.
   */
  readonly grammarExport?: string;

  // ---------------------------------------------------------------- declarations

  /** Node types declaring a class-like container (class, struct, impl, module). */
  readonly classTypes: readonly string[];
  /** Node types declaring an interface / protocol / trait. */
  readonly interfaceTypes: readonly string[];
  /** Node types declaring an enum. */
  readonly enumTypes: readonly string[];
  /** Node types declaring a type alias. */
  readonly typeAliasTypes: readonly string[];
  /** Node types declaring a free-standing function. */
  readonly functionTypes: readonly string[];
  /** Node types declaring a method when found inside a class body. */
  readonly methodTypes: readonly string[];
  /** Node types declaring a field / property inside a class body. */
  readonly propertyTypes: readonly string[];
  /** Node types for import / use / require statements. */
  readonly importTypes: readonly string[];
  /** Node types representing a call site. */
  readonly callTypes: readonly string[];

  // ---------------------------------------------------------------- name & body

  /** Field name holding a declaration's name. Default "name". */
  readonly nameField?: string;
  /** Child node types to fall back to when `nameField` is absent. */
  readonly nameFallbackTypes?: readonly string[];
  /** Field name holding a declaration's body. Default "body". */
  readonly bodyField?: string;
  /** Child node types to fall back to when `bodyField` is absent. */
  readonly bodyFallbackTypes?: readonly string[];

  /**
   * Custom name resolution, for languages where the name is buried rather than
   * being a direct field — C/C++ declarator chains, Rust `impl` type names.
   * Returning undefined falls back to the generic field/child lookup.
   */
  readonly resolveName?: (node: SyntaxNode) => string | undefined;

  /**
   * Decide a node's declaration kind when node type alone cannot.
   *
   * Needed by real grammars more often than the type-set model suggests:
   *  - Go puts structs and interfaces under the same `type_spec`, separated
   *    only by the `type` field.
   *  - Elixir has no declaration nodes at all — `defmodule` / `def` / `defp`
   *    are ordinary `call` nodes distinguished by their target text.
   *
   * Wins over the type sets. Return "Skip" to drop the node and its subtree.
   */
  readonly classify?: (node: SyntaxNode) => DeclKind | undefined;

  // ---------------------------------------------------------------- calls

  /** Field on a call node holding the callee. Default "function". */
  readonly callFunctionField?: string;
  /** Node types for member/attribute access appearing as a callee. */
  readonly callAccessorTypes?: readonly string[];
  /** Field on an accessor node holding the method name. Default "attribute". */
  readonly callAccessorField?: string;
  /** Custom callee-name resolution; wins over the generic path when it returns a value. */
  readonly resolveCallee?: (node: SyntaxNode) => string | undefined;

  /**
   * Where to collect a declaration's calls from.
   *
   * "declaration" (the default) walks the whole node. "body" walks only the
   * resolved body, which some grammars require: in Elixir a `def foo(x)`
   * signature is itself a `call` node, so walking the declaration would make
   * every function appear to call itself.
   */
  readonly callScope?: "declaration" | "body";

  /**
   * Node types that end call collection for the enclosing scope, so a nested
   * closure's calls are not attributed to its parent. Nested declarations are
   * still visited by the main walk and get their own nodes.
   */
  readonly functionBoundaryTypes?: readonly string[];

  /**
   * Callee names to drop when the callee is a **bare identifier**, to stop
   * language builtins from collapsing into one phantom hub node.
   *
   * This exists because of a documented failure in graphify
   * (graphify/extractors/go.py): an unexported Go method named `append`
   * absorbed 330 phantom inbound `calls` edges on an 8.9k-node codebase and
   * invented twelve database→service edges that were not in the source.
   *
   * Bare-identifier-only is the essential part of the rule. `h.append(v)` is a
   * genuine method call on a receiver and must not be filtered, so the check is
   * skipped whenever the callee came through an accessor node.
   */
  readonly builtinCallNames?: readonly string[];

  // ---------------------------------------------------------------- inheritance

  /** Fields on a class node carrying supertypes (e.g. "superclass"). */
  readonly extendsFields?: readonly string[];
  /** Child node types carrying supertypes (e.g. "class_heritage", "superclass"). */
  readonly extendsChildTypes?: readonly string[];
  /** Fields on a class node carrying implemented interfaces. */
  readonly implementsFields?: readonly string[];
  /** Child node types carrying implemented interfaces. */
  readonly implementsChildTypes?: readonly string[];

  // ---------------------------------------------------------------- hooks

  /** Pull the module specifier out of an import node. */
  readonly importSpec?: (node: SyntaxNode) => string | undefined;

  /** Detect a test file, returning the framework name. */
  readonly testDetector?: (root: SyntaxNode) => string | null;

  /**
   * Escape hatch run after generic dispatch for a node the config could not
   * describe. Return true to signal the node was fully handled and stop the
   * generic walk from descending into it.
   */
  readonly extraVisit?: (node: SyntaxNode, ctx: ExtractContext) => boolean | void;
}

/** Fields every config gets when it does not set them. */
export const CONFIG_DEFAULTS = {
  nameField: "name",
  bodyField: "body",
  callFunctionField: "function",
  callAccessorField: "attribute",
} as const;

/**
 * Strip generic parameters and qualifiers off a type reference so
 * `java.util.List<Foo>` and `List<Foo>` both bind to `List`.
 *
 * Kept deliberately blunt: the resolver downstream matches on simple names,
 * and an over-clever parse here would produce names that never match anything.
 */
export function simpleTypeName(raw: string): string | undefined {
  const withoutGenerics = raw.replace(/[<(\[].*$/s, "").trim();
  if (!withoutGenerics) return undefined;
  const segments = withoutGenerics.split(/::|[.\\]/);
  const last = segments[segments.length - 1]?.trim();
  if (!last) return undefined;
  // Reject anything that is not a plausible identifier (punctuation-only
  // fragments come from heritage clauses that include keywords or commas).
  return /^[A-Za-z_$][\w$]*$/.test(last) ? last : undefined;
}
