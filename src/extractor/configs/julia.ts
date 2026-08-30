import type { SyntaxNode } from "tree-sitter";
import type { LanguageConfig } from "../language-config";

const firstIdentifier = (node: SyntaxNode | null): string | undefined =>
  node?.descendantsOfType("identifier")[0]?.text;

export const julia: LanguageConfig = {
  id: "julia",
  grammarModule: "tree-sitter-julia",

  classTypes: ["struct_definition"],
  interfaceTypes: ["abstract_definition"],
  enumTypes: [],
  typeAliasTypes: [],
  functionTypes: ["function_definition", "short_function_definition"],
  methodTypes: [],
  propertyTypes: [],
  importTypes: ["using_statement", "import_statement"],
  callTypes: ["call_expression"],

  // Neither struct nor function carries a name field; the name sits inside a
  // `type_head` or a `signature`.
  resolveName: (node) =>
    firstIdentifier(
      node.namedChildren.find(
        (c) => c.type === "type_head" || c.type === "signature",
      ) ?? null,
    ),

  // The signature is a call_expression in this grammar, so it must not be
  // walked for calls or every function would call itself.
  functionBoundaryTypes: ["signature", "function_definition"],
  builtinCallNames: [
    "println", "print", "length", "push!", "pop!", "size", "zeros", "ones",
    "typeof", "convert", "error", "throw", "string", "collect", "sum", "map",
  ],
};
