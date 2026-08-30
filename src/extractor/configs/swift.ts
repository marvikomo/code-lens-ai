import type { SyntaxNode } from "tree-sitter";
import type { LanguageConfig } from "../language-config";

const navigationCallee = (node: SyntaxNode): string | undefined => {
  const target = node.namedChild(0);
  if (!target) return undefined;
  if (target.type === "navigation_expression") {
    const ids = target.descendantsOfType("simple_identifier");
    return ids[ids.length - 1]?.text;
  }
  return target.type === "simple_identifier" || target.type === "type_identifier"
    ? target.text
    : undefined;
};

export const swift: LanguageConfig = {
  id: "swift",
  grammarModule: "tree-sitter-swift",

  // class / struct / enum / extension all parse as class_declaration,
  // distinguished only by a keyword child.
  classTypes: ["class_declaration"],
  interfaceTypes: ["protocol_declaration"],
  enumTypes: [],
  typeAliasTypes: ["typealias_declaration"],
  functionTypes: ["function_declaration"],
  methodTypes: ["function_declaration", "protocol_function_declaration"],
  propertyTypes: ["property_declaration"],
  importTypes: ["import_declaration"],
  callTypes: ["call_expression"],

  bodyFallbackTypes: ["class_body", "function_body", "protocol_body"],
  functionBoundaryTypes: ["function_declaration", "lambda_literal"],
  extendsChildTypes: ["inheritance_specifier"],
  resolveCallee: navigationCallee,

  builtinCallNames: ["print", "debugPrint", "assert", "precondition", "fatalError", "String", "Int", "Array", "Dictionary"],

  testDetector: (root) =>
    /\b(XCTest|XCTAssert)\b/.test(root.text) ? "xctest" : null,
};
