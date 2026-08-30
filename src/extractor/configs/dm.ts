import type { LanguageConfig } from "../language-config";

/** DreamMaker (BYOND). Types are path expressions such as `/obj/item`. */
export const dm: LanguageConfig = {
  id: "dm",
  grammarModule: "tree-sitter-dm",

  classTypes: ["type_definition"],
  interfaceTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  functionTypes: [],
  methodTypes: ["type_proc_definition"],
  propertyTypes: ["var_definition"],
  importTypes: [],
  callTypes: ["call_expression"],

  bodyFallbackTypes: ["type_body"],
  callFunctionField: "name",
  functionBoundaryTypes: ["type_proc_definition"],

  resolveName: (node) =>
    node.type === "type_definition"
      ? node.namedChildren.find((c) => c.type === "type_path")?.text
      : undefined,
};
