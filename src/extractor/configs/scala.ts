import type { LanguageConfig } from "../language-config";

export const scala: LanguageConfig = {
  id: "scala",
  grammarModule: "tree-sitter-scala",

  classTypes: ["class_definition", "object_definition", "case_class_definition"],
  interfaceTypes: ["trait_definition"],
  enumTypes: ["enum_definition"],
  typeAliasTypes: ["type_definition"],
  functionTypes: ["function_definition"],
  methodTypes: ["function_definition", "function_declaration"],
  propertyTypes: ["val_definition", "var_definition", "val_declaration"],
  importTypes: ["import_declaration"],
  callTypes: ["call_expression"],

  nameFallbackTypes: ["identifier"],
  callAccessorTypes: ["field_expression"],
  callAccessorField: "field",
  functionBoundaryTypes: ["function_definition", "lambda_expression"],
  extendsChildTypes: ["extends_clause"],

  builtinCallNames: ["println", "print", "require", "assert", "apply", "Some", "None", "List", "Seq", "Map"],

  testDetector: (root) =>
    /\b(FunSuite|AnyFlatSpec|ScalaTest|munit)\b/.test(root.text) ? "scalatest" : null,
};
