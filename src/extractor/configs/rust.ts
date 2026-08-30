import type { LanguageConfig } from "../language-config";

export const rust: LanguageConfig = {
  id: "rust",
  grammarModule: "tree-sitter-rust",

  classTypes: ["struct_item", "impl_item", "mod_item", "union_item"],
  interfaceTypes: ["trait_item"],
  enumTypes: ["enum_item"],
  typeAliasTypes: ["type_item"],
  functionTypes: ["function_item"],
  methodTypes: ["function_item", "function_signature_item"],
  propertyTypes: ["field_declaration"],
  importTypes: ["use_declaration"],
  callTypes: ["call_expression", "macro_invocation"],

  bodyFallbackTypes: ["declaration_list", "field_declaration_list", "block"],
  callAccessorTypes: ["field_expression", "scoped_identifier"],
  callAccessorField: "field",
  functionBoundaryTypes: ["function_item", "closure_expression"],

  // `impl Drawer for Shape` carries the implementing type in `type` and the
  // trait in `trait`; naming the block after the type is what makes its methods
  // land on the same node as the struct's own.
  resolveName: (node) =>
    node.type === "impl_item"
      ? node.childForFieldName("type")?.text
      : undefined,
  implementsFields: ["trait"],

  builtinCallNames: [
    "println", "print", "eprintln", "eprint", "format", "vec", "write",
    "writeln", "panic", "assert", "assert_eq", "assert_ne", "debug_assert",
    "todo", "unimplemented", "unreachable", "matches", "dbg", "include_str",
    "Some", "None", "Ok", "Err", "drop",
  ],

  testDetector: (root) =>
    root.text.includes("#[test]") || root.text.includes("#[cfg(test)]")
      ? "cargo-test"
      : null,
};
