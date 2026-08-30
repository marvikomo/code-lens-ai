import type { LanguageConfig } from "../language-config";

/** Node types verified against tree-sitter-python 0.25. */
export const python: LanguageConfig = {
  id: "python",
  grammarModule: "tree-sitter-python",

  classTypes: ["class_definition"],
  interfaceTypes: [],
  enumTypes: [],
  typeAliasTypes: ["type_alias_statement"],
  functionTypes: ["function_definition"],
  methodTypes: ["function_definition"],
  // Class-level attributes are plain `assignment` nodes wrapped in
  // `expression_statement`, indistinguishable from module-level constants
  // without type inference. Left out rather than guessed at.
  propertyTypes: [],
  importTypes: ["import_statement", "import_from_statement"],
  callTypes: ["call"],

  callAccessorTypes: ["attribute"],
  callAccessorField: "attribute",
  functionBoundaryTypes: ["function_definition", "lambda"],

  // `Widget(Base, Mixin)` puts the bases in an unnamed argument_list, not a
  // field — confirmed by dumping the CST rather than assuming a `superclass`.
  extendsChildTypes: ["argument_list"],

  builtinCallNames: [
    "print", "len", "range", "str", "int", "float", "bool", "list", "dict",
    "set", "tuple", "isinstance", "issubclass", "super", "type", "open",
    "sorted", "enumerate", "zip", "map", "filter", "sum", "min", "max", "abs",
    "round", "repr", "hash", "id", "getattr", "setattr", "hasattr", "delattr",
    "format", "next", "iter", "any", "all", "vars", "dir", "callable",
  ],

  importSpec: (node) => {
    const moduleName = node.childForFieldName("module_name");
    if (moduleName?.text) return moduleName.text.trim();
    const dotted = node.namedChildren.find(
      (c) => c.type === "dotted_name" || c.type === "relative_import",
    );
    return dotted?.text?.trim();
  },

  testDetector: (root) => {
    const hasPytestImport = root
      .descendantsOfType(["import_statement", "import_from_statement"])
      .some((n) => /\b(pytest|unittest)\b/.test(n.text));
    if (hasPytestImport) return "pytest";
    const hasTestDef = root
      .descendantsOfType("function_definition")
      .some((n) => (n.childForFieldName("name")?.text ?? "").startsWith("test_"));
    return hasTestDef ? "pytest" : null;
  },
};
