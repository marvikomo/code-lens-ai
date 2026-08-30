import type { LanguageConfig } from "../language-config";

export const groovy: LanguageConfig = {
  id: "groovy",
  grammarModule: "tree-sitter-groovy",

  classTypes: ["class_declaration"],
  interfaceTypes: ["interface_declaration"],
  enumTypes: ["enum_declaration"],
  typeAliasTypes: [],
  functionTypes: ["function_definition"],
  methodTypes: ["method_declaration", "constructor_declaration"],
  propertyTypes: ["field_declaration"],
  importTypes: ["import_declaration"],
  callTypes: ["method_invocation"],

  // `method_invocation` names the callee in `name` for both bare and
  // receiver-qualified calls, with the receiver in `object`.
  callFunctionField: "name",
  functionBoundaryTypes: ["method_declaration", "closure"],
  extendsFields: ["superclass"],
  implementsChildTypes: ["super_interfaces"],

  builtinCallNames: ["println", "print", "printf", "assert", "each", "collect"],

  testDetector: (root) => (/\bSpecification\b/.test(root.text) ? "spock" : null),
};
