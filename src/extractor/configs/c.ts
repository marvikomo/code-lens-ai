import type { SyntaxNode } from "tree-sitter";
import type { LanguageConfig } from "../language-config";

/**
 * C declares a function's name through a chain of declarators
 * (`function_definition` → `function_declarator` → `pointer_declarator` → …),
 * so the name has to be unwrapped rather than read off a field.
 */
export function unwrapDeclarator(node: SyntaxNode): string | undefined {
  let current: SyntaxNode | null = node.childForFieldName("declarator");
  let guard = 0;
  while (current && guard++ < 16) {
    if (current.type === "identifier" || current.type === "field_identifier") {
      return current.text;
    }
    const next: SyntaxNode | null =
      current.childForFieldName("declarator") ??
      current.namedChildren.find((c) => c.type.endsWith("declarator")) ??
      null;
    if (!next) {
      return current.namedChildren.find(
        (c) => c.type === "identifier" || c.type === "field_identifier",
      )?.text;
    }
    current = next;
  }
  return undefined;
}

const declaratorName = (node: SyntaxNode): string | undefined =>
  node.type === "function_definition" ||
  node.type === "field_declaration" ||
  node.type === "type_definition" ||
  node.type === "declaration"
    ? unwrapDeclarator(node)
    : undefined;

/** `#include <stdio.h>` / `#include "local.h"` → the header path. */
const includeSpec = (node: SyntaxNode): string | undefined => {
  const target =
    node.childForFieldName("path") ??
    node.namedChildren.find(
      (c) => c.type === "system_lib_string" || c.type === "string_literal",
    );
  return target?.text?.replace(/^[<"']|[>"']$/g, "").trim();
};

export const c: LanguageConfig = {
  id: "c",
  grammarModule: "tree-sitter-c",

  classTypes: ["struct_specifier", "union_specifier"],
  interfaceTypes: [],
  enumTypes: ["enum_specifier"],
  typeAliasTypes: ["type_definition"],
  functionTypes: ["function_definition"],
  methodTypes: [],
  propertyTypes: ["field_declaration"],
  importTypes: ["preproc_include"],
  callTypes: ["call_expression"],

  callAccessorTypes: ["field_expression"],
  callAccessorField: "field",
  functionBoundaryTypes: ["function_definition"],
  resolveName: declaratorName,
  importSpec: includeSpec,

  builtinCallNames: [
    "printf", "fprintf", "sprintf", "snprintf", "malloc", "calloc", "realloc",
    "free", "memcpy", "memset", "memmove", "strlen", "strcpy", "strncpy",
    "strcmp", "strncmp", "sizeof", "assert", "exit", "abort", "fopen",
    "fclose", "fread", "fwrite",
  ],
};

export const cpp: LanguageConfig = {
  ...c,
  id: "cpp",
  grammarModule: "tree-sitter-cpp",

  classTypes: [
    "struct_specifier",
    "union_specifier",
    "class_specifier",
    "namespace_definition",
  ],
  methodTypes: ["function_definition", "declaration"],
  functionTypes: ["function_definition"],
  callTypes: ["call_expression", "new_expression"],
  extendsChildTypes: ["base_class_clause"],

  builtinCallNames: [...(c.builtinCallNames ?? []), "make_shared", "make_unique", "move", "forward"],
};
