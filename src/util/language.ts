import path from "path";

/**
 * Languages with a bespoke extractor. These parse with no extra install and no
 * async preload, and they carry richer extraction (routes, exports,
 * re-exports) than the generic path.
 */
export type BuiltinLanguage = "javascript" | "typescript" | "tsx" | "java";

/** Languages served by a `LanguageConfig` plus the generic walker. */
export type ConfigLanguage =
  | "python"
  | "go"
  | "rust"
  | "ruby"
  | "csharp"
  | "php"
  | "scala"
  | "groovy"
  | "c"
  | "cpp"
  | "objc"
  | "kotlin"
  | "swift"
  | "elixir"
  | "julia"
  | "powershell"
  | "ocaml"
  | "commonlisp"
  | "dm"
  | "bash";

export type SupportedLanguage = BuiltinLanguage | ConfigLanguage;

export const BUILTIN_LANGUAGES: readonly BuiltinLanguage[] = [
  "javascript",
  "typescript",
  "tsx",
  "java",
];

export function isBuiltinLanguage(lang: SupportedLanguage): lang is BuiltinLanguage {
  return (BUILTIN_LANGUAGES as readonly string[]).includes(lang);
}

/**
 * Extension → language.
 *
 * Ambiguous extensions are resolved the same way graphify resolves them, so the
 * two tools agree on what a file is:
 *   `.h`  → C      (not C++; the majority of headers in mixed trees are C)
 *   `.m`  → Objective-C (not MATLAB)
 *   `.pp` is left out entirely — Pascal and Puppet both claim it and neither
 *         grammar is available here.
 */
const EXTENSIONS: Readonly<Record<string, SupportedLanguage>> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".java": "java",

  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".rake": "ruby",
  ".cs": "csharp",
  ".php": "php",
  ".scala": "scala",
  ".sc": "scala",
  ".groovy": "groovy",
  ".gradle": "groovy",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".cu": "cpp",
  ".m": "objc",
  ".mm": "objc",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".ex": "elixir",
  ".exs": "elixir",
  ".jl": "julia",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".lisp": "commonlisp",
  ".cl": "commonlisp",
  ".lsp": "commonlisp",
  ".asd": "commonlisp",
  ".dm": "dm",
  ".dme": "dm",
  ".sh": "bash",
  ".bash": "bash",
};

export function detectLanguage(filePath: string): SupportedLanguage | null {
  return EXTENSIONS[path.extname(filePath).toLowerCase()] ?? null;
}

/** Every extension the indexer will attempt to parse. */
export function supportedExtensions(): string[] {
  return Object.keys(EXTENSIONS);
}
