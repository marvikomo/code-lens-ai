import type { SyntaxNode } from "tree-sitter";
import type { LanguageConfig } from "../language-config";

const firstOfType = (node: SyntaxNode, types: string[]): string | undefined => {
  for (const t of types) {
    const found = node.descendantsOfType(t)[0];
    if (found?.text) return found.text;
  }
  return undefined;
};

export const ocaml: LanguageConfig = {
  id: "ocaml",
  grammarModule: "tree-sitter-ocaml",
  grammarExport: "ocaml",

  classTypes: ["module_definition"],
  interfaceTypes: ["module_type_definition"],
  enumTypes: [],
  typeAliasTypes: ["type_definition"],
  functionTypes: ["value_definition"],
  methodTypes: [],
  propertyTypes: [],
  importTypes: ["open_module"],
  callTypes: ["application_expression"],

  bodyFallbackTypes: ["structure"],
  functionBoundaryTypes: ["fun_expression", "value_definition"],

  // Names live one level down: module_binding → module_name,
  // let_binding → value_name, type_binding → type_constructor.
  resolveName: (node) =>
    firstOfType(node, ["module_name", "value_name", "type_constructor"]),

  importSpec: (node) => node.childForFieldName("module")?.text ?? firstOfType(node, ["module_path"]),

  builtinCallNames: ["print_endline", "print_string", "failwith", "raise", "ignore", "ref", "incr", "decr"],
};
