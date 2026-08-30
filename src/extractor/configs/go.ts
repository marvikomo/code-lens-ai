import type { LanguageConfig } from "../language-config";

/**
 * Go puts structs and interfaces under one `type_spec` node, separated only by
 * the `type` field, so the classifier does the work the type tables cannot.
 */
export const go: LanguageConfig = {
  id: "go",
  grammarModule: "tree-sitter-go",

  classTypes: [],
  interfaceTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  // Go methods are declared at file scope with a receiver, not inside a type
  // body, so both forms are file-level functions here.
  functionTypes: ["function_declaration", "method_declaration"],
  methodTypes: ["method_elem"],
  propertyTypes: ["field_declaration"],
  importTypes: ["import_spec"],
  callTypes: ["call_expression"],

  // A struct's members live under the `type` field (struct_type →
  // field_declaration_list), so that is where member collection starts.
  bodyField: "type",
  callAccessorTypes: ["selector_expression"],
  callAccessorField: "field",
  functionBoundaryTypes: ["func_literal", "function_declaration", "method_declaration"],

  classify: (node) => {
    if (node.type !== "type_spec") return undefined;
    const type = node.childForFieldName("type")?.type;
    if (type === "struct_type") return "Class";
    if (type === "interface_type") return "Interface";
    return "TypeAlias";
  },

  /**
   * Go's predeclared functions, filtered only when the callee is a bare
   * identifier.
   *
   * This list is carried over from graphify (graphify/extractors/go.py), which
   * documents what happens without it: an unexported method named `append`
   * collected 330 phantom inbound calls edges on an 8.9k-node codebase and
   * fabricated twelve database→service layering edges. Bare-identifier-only
   * matters just as much — `h.append(v)` and `pkg.Delete(x)` are real calls and
   * must survive, which the accessor check in the walker guarantees.
   */
  builtinCallNames: [
    // Predeclared functions.
    "append", "cap", "clear", "close", "complex", "copy", "delete", "imag",
    "len", "make", "max", "min", "new", "panic", "print", "println", "real",
    "recover",

    // Predeclared *types*. graphify leaves these out, noting that Go
    // conversions are call-shaped but "produced no phantom edges on that
    // corpus". Measuring a different corpus contradicts that: on k6 (3.5k
    // files) bare conversions produced 10,626 call edges to type names, and
    // 2,474 of them bound onto real user functions that happen to be named
    // `error`, `string`, `int64` and `rune` — the same phantom-hub failure the
    // function list exists to prevent, just arriving through conversions.
    //
    // Safe for the same reason the function list is: bare-identifier-only. A
    // conversion is always written `int(x)`, never `pkg.int(x)`, so genuine
    // method calls are untouched. The set is the Go spec's predeclared type
    // list in full.
    "bool", "byte", "complex64", "complex128", "error", "float32", "float64",
    "int", "int8", "int16", "int32", "int64", "rune", "string", "uint",
    "uint8", "uint16", "uint32", "uint64", "uintptr", "any", "comparable",
  ],

  // Go encodes visibility in the identifier: only a capitalised name is
  // importable from another package. Advertising `helper` as exported would
  // let the import-aware resolver bind cross-package calls that the compiler
  // would reject.
  isExported: (_node, name) => /^[A-Z]/.test(name),

  testDetector: (root) =>
    root
      .descendantsOfType("function_declaration")
      .some((n) => (n.childForFieldName("name")?.text ?? "").startsWith("Test"))
      ? "gotest"
      : null,
};
