import type { LanguageConfig } from "../language-config";

/**
 * This grammar only gives structure to `defun`; `defclass`, `defmethod` and the
 * rest stay undifferentiated `list_lit` nodes, and there is no call node at
 * all. Rather than reconstructing Lisp semantics from generic lists — which
 * would mean inventing edges the parse does not support — this config extracts
 * functions and nothing else.
 */
export const commonlisp: LanguageConfig = {
  id: "commonlisp",
  grammarModule: "tree-sitter-commonlisp",

  classTypes: [],
  interfaceTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  functionTypes: ["defun"],
  methodTypes: [],
  propertyTypes: [],
  importTypes: [],
  callTypes: [],

  // defun → defun_header → [defun_keyword, sym_lit(name), list_lit(params)]
  resolveName: (node) => {
    const header = node.namedChildren.find((c) => c.type === "defun_header");
    return header?.namedChildren.find((c) => c.type === "sym_lit")?.text;
  },
};
