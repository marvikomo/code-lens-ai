import type { LanguageConfig } from "../language-config";

export const php: LanguageConfig = {
  id: "php",
  grammarModule: "tree-sitter-php",
  grammarExport: "php",

  classTypes: ["class_declaration", "trait_declaration"],
  interfaceTypes: ["interface_declaration"],
  enumTypes: ["enum_declaration"],
  typeAliasTypes: [],
  functionTypes: ["function_definition"],
  methodTypes: ["method_declaration"],
  propertyTypes: ["property_declaration"],
  importTypes: ["namespace_use_declaration"],
  callTypes: [
    "function_call_expression",
    "member_call_expression",
    "scoped_call_expression",
    "object_creation_expression",
  ],

  functionBoundaryTypes: ["function_definition", "method_declaration", "anonymous_function_creation_expression"],
  extendsChildTypes: ["base_clause"],
  implementsChildTypes: ["class_interface_clause"],

  // The three call forms disagree on which field holds the callee:
  // `function_call_expression` uses `function`, the member and scoped forms
  // use `name`.
  resolveCallee: (node) => {
    if (node.type === "function_call_expression") {
      return node.childForFieldName("function")?.text?.replace(/^\\+/, "");
    }
    if (node.type === "object_creation_expression") {
      return node.namedChild(0)?.text?.replace(/^\\+/, "");
    }
    return node.childForFieldName("name")?.text;
  },

  builtinCallNames: [
    "array", "count", "isset", "empty", "unset", "die", "exit", "echo",
    "print_r", "var_dump", "implode", "explode", "sprintf", "printf",
    "in_array", "array_map", "array_filter", "array_merge", "json_encode",
    "json_decode", "strlen", "str_replace", "preg_match", "define",
  ],

  testDetector: (root) =>
    /\b(PHPUnit|TestCase)\b/.test(root.text) ? "phpunit" : null,
};
