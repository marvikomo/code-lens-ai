import type { SyntaxNode } from "tree-sitter";
import type { LanguageConfig } from "../language-config";

/** Trailing `simple_identifier` of a navigation chain — `a.b.meth` → `meth`. */
const navigationCallee = (node: SyntaxNode): string | undefined => {
  const target = node.namedChild(0);
  if (!target) return undefined;
  if (target.type === "navigation_expression") {
    const ids = target.descendantsOfType("simple_identifier");
    return ids[ids.length - 1]?.text;
  }
  return target.type === "simple_identifier" ? target.text : undefined;
};

export const kotlin: LanguageConfig = {
  id: "kotlin",
  grammarModule: "tree-sitter-kotlin",

  // This grammar has no distinct interface node — `interface Foo` parses as a
  // class_declaration — so interfaces surface as Class nodes.
  classTypes: ["class_declaration", "object_declaration"],
  interfaceTypes: [],
  enumTypes: ["enum_class_body"],
  typeAliasTypes: ["type_alias"],
  functionTypes: ["function_declaration"],
  methodTypes: ["function_declaration"],
  propertyTypes: ["property_declaration"],
  importTypes: ["import_header"],
  callTypes: ["call_expression"],

  // Declarations carry no `name` field; the identifier is a bare child.
  nameFallbackTypes: ["type_identifier", "simple_identifier"],
  bodyFallbackTypes: ["class_body", "function_body", "enum_class_body"],
  functionBoundaryTypes: ["function_declaration", "lambda_literal", "anonymous_function"],
  extendsChildTypes: ["delegation_specifier"],
  resolveCallee: navigationCallee,

  resolveName: (node) =>
    node.type === "property_declaration"
      ? node.descendantsOfType("simple_identifier")[0]?.text
      : undefined,

  builtinCallNames: ["println", "print", "listOf", "mutableListOf", "mapOf", "setOf", "require", "check", "TODO"],

  testDetector: (root) => (/@Test\b/.test(root.text) ? "junit" : null),
};
