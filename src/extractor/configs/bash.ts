import type { LanguageConfig } from "../language-config";

export const bash: LanguageConfig = {
  id: "bash",
  grammarModule: "tree-sitter-bash",

  classTypes: [],
  interfaceTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  functionTypes: ["function_definition"],
  methodTypes: [],
  propertyTypes: [],
  // `source ./lib.sh` is a command like any other, not an import node.
  importTypes: [],
  callTypes: ["command"],

  callFunctionField: "name",
  functionBoundaryTypes: ["function_definition", "subshell"],

  builtinCallNames: [
    "echo", "printf", "cd", "exit", "return", "export", "local", "read",
    "set", "unset", "shift", "eval", "test", "source", "trap", "wait",
    "true", "false", "shopt", "declare", "readonly",
  ],
};
