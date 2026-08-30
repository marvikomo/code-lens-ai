import type { LanguageConfig } from "../language-config";

export const powershell: LanguageConfig = {
  id: "powershell",
  grammarModule: "tree-sitter-powershell",

  classTypes: ["class_statement"],
  interfaceTypes: [],
  enumTypes: ["enum_statement"],
  typeAliasTypes: [],
  functionTypes: ["function_statement"],
  methodTypes: ["class_method_definition"],
  propertyTypes: ["class_property_definition"],
  importTypes: ["using_statement"],
  callTypes: ["command"],

  // No name fields anywhere in this grammar — names are bare children, and a
  // class_statement lists its own name and its base class as sibling
  // `simple_name` nodes with nothing to tell them apart, so inheritance is left
  // unmodelled rather than guessed.
  nameFallbackTypes: ["function_name", "simple_name", "variable"],
  functionBoundaryTypes: ["function_statement", "script_block_expression"],

  builtinCallNames: [
    "Write-Host", "Write-Output", "Write-Error", "Write-Verbose", "Get-Item",
    "Set-Item", "Out-Null", "ForEach-Object", "Where-Object", "Select-Object",
  ],

  testDetector: (root) => (/\bDescribe\b|\bPester\b/.test(root.text) ? "pester" : null),
};
