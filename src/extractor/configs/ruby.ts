import type { LanguageConfig } from "../language-config";

export const ruby: LanguageConfig = {
  id: "ruby",
  grammarModule: "tree-sitter-ruby",

  classTypes: ["class", "module", "singleton_class"],
  interfaceTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  functionTypes: ["method", "singleton_method"],
  methodTypes: ["method", "singleton_method"],
  propertyTypes: [],
  // `require 'set'` parses as an ordinary call, not an import node, so Ruby
  // contributes no IMPORTS edges rather than fabricating them from call text.
  importTypes: [],
  callTypes: ["call"],

  // A ruby `call` carries the invoked name in `method`, with the receiver in a
  // separate `receiver` field — no accessor unwrapping needed.
  callFunctionField: "method",
  functionBoundaryTypes: ["method", "singleton_method", "block", "do_block"],

  extendsFields: ["superclass"],

  builtinCallNames: [
    "puts", "print", "p", "require", "require_relative", "attr_accessor",
    "attr_reader", "attr_writer", "include", "extend", "raise", "loop",
    "lambda", "proc", "freeze", "new", "to_s", "to_i", "to_sym", "nil?",
  ],

  testDetector: (root) =>
    /\b(RSpec|describe|it_behaves_like|Minitest)\b/.test(root.text)
      ? "rspec"
      : null,
};
