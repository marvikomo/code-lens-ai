import type { SyntaxNode } from "tree-sitter";
import type { LanguageConfig } from "../language-config";

/**
 * Elixir has no declaration nodes. `defmodule`, `def` and `defp` are ordinary
 * `call` nodes whose target happens to be that identifier, so everything here
 * runs through the classifier.
 */
const DEFINE_FUNCTION = new Set(["def", "defp", "defmacro", "defmacrop"]);
const IMPORT_FORMS = new Set(["alias", "import", "require", "use"]);

const targetText = (node: SyntaxNode): string | undefined =>
  node.type === "call" ? node.childForFieldName("target")?.text : undefined;

/**
 * `arguments` is a named child of a call, not a field — `childForFieldName`
 * returns nothing for it, which silently produced `<anonymous>` names until a
 * real parse was inspected.
 */
const argumentsOf = (node: SyntaxNode): SyntaxNode | undefined =>
  node.namedChildren.find((c) => c.type === "arguments");

export const elixir: LanguageConfig = {
  id: "elixir",
  grammarModule: "tree-sitter-elixir",

  classTypes: [],
  interfaceTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  functionTypes: [],
  methodTypes: [],
  propertyTypes: [],
  importTypes: [],
  callTypes: ["call"],

  bodyFallbackTypes: ["do_block"],
  // A `def foo(x)` signature is itself a call node; collecting calls from the
  // declaration would make every function call itself.
  callScope: "body",
  functionBoundaryTypes: ["fn"],

  classify: (node) => {
    const target = targetText(node);
    if (!target) return undefined;
    if (target === "defmodule" || target === "defprotocol") return "Class";
    if (DEFINE_FUNCTION.has(target)) return "Function";
    if (IMPORT_FORMS.has(target)) return "Import";
    return undefined;
  },

  resolveName: (node) => {
    const target = targetText(node);
    if (!target) return undefined;
    const args = argumentsOf(node);
    if (!args) return undefined;
    const first = args.namedChild(0);
    if (!first) return undefined;
    // `defmodule App.Widget do` → the module alias.
    if (target === "defmodule" || target === "defprotocol") return first.text;
    // `def draw(x) do` → the signature is a nested call whose target is the name.
    if (first.type === "call") return first.childForFieldName("target")?.text;
    // `def draw do` → a bare identifier.
    return first.text;
  },

  importSpec: (node) => argumentsOf(node)?.namedChild(0)?.text,

  resolveCallee: (node) => {
    const target = node.childForFieldName("target");
    if (!target) return undefined;
    const text = target.text;
    // Never treat a definition keyword as a call.
    if (DEFINE_FUNCTION.has(text) || IMPORT_FORMS.has(text)) return undefined;
    if (text === "defmodule" || text === "defprotocol") return undefined;
    // `Mod.meth(x)` arrives as a `dot` target; take the trailing segment.
    return text.includes(".") ? text.split(".").pop() : text;
  },

  testDetector: (root) => (/\bExUnit\b/.test(root.text) ? "exunit" : null),
};
