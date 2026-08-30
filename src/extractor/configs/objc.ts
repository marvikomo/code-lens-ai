import type { LanguageConfig } from "../language-config";

export const objc: LanguageConfig = {
  id: "objc",
  grammarModule: "tree-sitter-objc",

  // @interface and @implementation are separate nodes for the same type; both
  // become Class nodes and merge on id, so declaration and definition land
  // together.
  classTypes: ["class_interface", "class_implementation", "category_interface"],
  interfaceTypes: ["protocol_declaration"],
  enumTypes: ["enum_specifier"],
  typeAliasTypes: ["type_definition"],
  functionTypes: ["function_definition"],
  methodTypes: ["method_declaration", "method_definition"],
  propertyTypes: ["property_declaration"],
  importTypes: ["preproc_include", "preproc_import"],
  callTypes: ["call_expression", "message_expression"],

  nameFallbackTypes: ["identifier"],
  extendsFields: ["superclass"],
  functionBoundaryTypes: ["function_definition", "method_definition"],

  // A `message_expression` keeps the selector in `method` and the receiver in
  // `receiver`; the default namedChild(0) path would pick up the receiver.
  resolveCallee: (node) =>
    node.type === "message_expression"
      ? node.childForFieldName("method")?.text
      : node.childForFieldName("function")?.text,

  importSpec: (node) =>
    node.namedChildren
      .find((c) => c.type === "system_lib_string" || c.type === "string_literal")
      ?.text?.replace(/^[<"']|[>"']$/g, "")
      .trim(),
};
