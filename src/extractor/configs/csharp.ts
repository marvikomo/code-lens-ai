import type { LanguageConfig } from "../language-config";

export const csharp: LanguageConfig = {
  id: "csharp",
  grammarModule: "tree-sitter-c-sharp",

  classTypes: ["class_declaration", "struct_declaration", "record_declaration"],
  interfaceTypes: ["interface_declaration"],
  enumTypes: ["enum_declaration"],
  typeAliasTypes: [],
  functionTypes: ["local_function_statement"],
  methodTypes: ["method_declaration", "constructor_declaration", "destructor_declaration"],
  propertyTypes: ["field_declaration", "property_declaration", "event_field_declaration"],
  importTypes: ["using_directive"],
  callTypes: ["invocation_expression", "object_creation_expression"],

  callAccessorTypes: ["member_access_expression"],
  callAccessorField: "name",
  functionBoundaryTypes: ["method_declaration", "local_function_statement", "lambda_expression"],

  /**
   * C# writes base class and interfaces in one undifferentiated `base_list`, so
   * every entry is emitted as EXTENDS. Splitting them correctly needs a
   * cross-file pre-scan of which names are interfaces (graphify does exactly
   * that in `_csharp_classify_base`); guessing from an `I`-prefix convention
   * would invent relationships the source does not state. The name-based
   * resolver downstream binds to whichever node actually exists.
   */
  extendsChildTypes: ["base_list"],

  builtinCallNames: ["nameof", "typeof", "sizeof", "default"],

  testDetector: (root) =>
    /\[(Test|Fact|Theory|TestMethod)\]/.test(root.text) ? "dotnet-test" : null,
};
