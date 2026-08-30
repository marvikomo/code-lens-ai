import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import Java from "tree-sitter-java";
import TS from "tree-sitter-typescript";
import { isBuiltinLanguage, SupportedLanguage } from "./language";
import { LANGUAGE_CONFIGS } from "../extractor/configs";

// The grammar packages declare `Language.language` as `unknown` (correct: it's
// an opaque native pointer), while the `tree-sitter` package declares it as
// recursively `Language` — structurally impossible. Cast through unknown so
// TypeScript stops rejecting the assignment.
const asLang = (g: unknown): Parser.Language => g as Parser.Language;

const cache = new Map<SupportedLanguage, Parser>();

/** Languages whose grammar failed to load, with the reason, so we warn once. */
const unavailable = new Map<SupportedLanguage, string>();

/**
 * Thrown by `getParser` when a language's grammar is not installed, failed to
 * build, or is incompatible with the installed tree-sitter runtime.
 *
 * Callers are expected to skip the file rather than abort the index — one
 * missing optional grammar should cost you that language, not the whole run.
 */
export class GrammarUnavailableError extends Error {
  constructor(
    readonly language: SupportedLanguage,
    readonly grammarModule: string,
    readonly reason: string,
  ) {
    super(
      `grammar for "${language}" is unavailable (${reason}). ` +
        `Install it with: npm install ${grammarModule}`,
    );
    this.name = "GrammarUnavailableError";
  }
}

/**
 * `import()` kept out of TypeScript's reach.
 *
 * With `module: commonjs`, tsc rewrites a literal `import()` into `require()`,
 * which cannot load an ES module — and two grammars we support
 * (`tree-sitter-c-sharp`, `tree-sitter-powershell`) are ESM-only and throw
 * "require() cannot be used on an ESM graph with top-level await". Going
 * through `new Function` keeps a real dynamic import in the emitted JS.
 */
const dynamicImport = new Function(
  "specifier",
  "return import(specifier);",
) as (specifier: string) => Promise<Record<string, unknown>>;

/**
 * Load a grammar with `require`.
 *
 * Most grammar packages are CommonJS, so this synchronous path covers them and
 * makes `preloadGrammars` optional for those languages — which also means the
 * Jest runner, which cannot service a real dynamic import without
 * `--experimental-vm-modules`, can still load them.
 */
function requireGrammar(config: {
  grammarModule: string;
  grammarExport?: string;
}): unknown | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(config.grammarModule) as Record<string, unknown>;
    const root = (mod.default ?? mod) as Record<string, unknown>;
    return config.grammarExport ? root[config.grammarExport] : root;
  } catch {
    return null;
  }
}

function builtinGrammar(language: SupportedLanguage): unknown | null {
  switch (language) {
    case "javascript":
      return JavaScript;
    case "typescript":
      return TS.typescript;
    case "tsx":
      return TS.tsx;
    case "java":
      return Java;
    default:
      return null;
  }
}

function makeParser(grammar: unknown): Parser {
  const parser = new Parser();
  parser.setLanguage(asLang(grammar));
  return parser;
}

/**
 * Load the grammars for `languages`, skipping any already cached.
 *
 * Must be awaited before `getParser` is called for a non-builtin language.
 * Failures are collected rather than thrown: an index over a polyglot repo
 * should still cover the languages whose grammars did load.
 */
export async function preloadGrammars(
  languages: readonly SupportedLanguage[],
): Promise<{
  loaded: SupportedLanguage[];
  failed: { language: SupportedLanguage; reason: string }[];
}> {
  const wanted = Array.from(new Set(languages)).filter(
    (lang) => !cache.has(lang) && !unavailable.has(lang),
  );

  const results = await Promise.all(
    wanted.map(async (language) => {
      const builtin = builtinGrammar(language);
      if (builtin) {
        cache.set(language, makeParser(builtin));
        return { language, ok: true as const };
      }

      const config = LANGUAGE_CONFIGS[language];
      if (!config) {
        return { language, ok: false as const, reason: "no language config" };
      }

      try {
        // CommonJS grammars resolve here; only genuinely ESM-only packages
        // (tree-sitter-c-sharp, tree-sitter-powershell) reach the import().
        const required = requireGrammar(config);
        if (required) {
          cache.set(language, makeParser(required));
          return { language, ok: true as const };
        }

        const loaded = await dynamicImport(config.grammarModule);
        const root = (loaded.default ?? loaded) as Record<string, unknown>;
        const grammar = config.grammarExport ? root[config.grammarExport] : root;
        if (!grammar) {
          return {
            language,
            ok: false as const,
            reason: `module has no export "${config.grammarExport}"`,
          };
        }
        // Build the parser now rather than at first use: an ABI-incompatible
        // grammar only fails when it is handed to setLanguage, and we want that
        // failure here, where it degrades to "skip this language", not mid-walk.
        cache.set(language, makeParser(grammar));
        return { language, ok: true as const };
      } catch (err) {
        return {
          language,
          ok: false as const,
          reason: (err as Error).message.split("\n")[0],
        };
      }
    }),
  );

  const failed: { language: SupportedLanguage; reason: string }[] = [];
  for (const result of results) {
    if (result.ok) continue;
    unavailable.set(result.language, result.reason);
    failed.push({ language: result.language, reason: result.reason });
  }

  return {
    loaded: results.filter((r) => r.ok).map((r) => r.language),
    failed,
  };
}

/**
 * Parser for `language`.
 *
 * Builtin languages load lazily and always work. Config-driven languages must
 * have been through `preloadGrammars` first, because their grammars may need a
 * real ESM `import()`, which cannot be done synchronously.
 */
export function getParser(language: SupportedLanguage): Parser {
  const cached = cache.get(language);
  if (cached) return cached;

  const builtin = builtinGrammar(language);
  if (builtin) {
    const parser = makeParser(builtin);
    cache.set(language, parser);
    return parser;
  }

  const config = LANGUAGE_CONFIGS[language];
  if (config && !unavailable.has(language)) {
    const grammar = requireGrammar(config);
    if (grammar) {
      try {
        const parser = makeParser(grammar);
        cache.set(language, parser);
        return parser;
      } catch (err) {
        // An ABI-incompatible grammar loads but cannot be handed to
        // setLanguage; record it so we do not retry per file.
        unavailable.set(language, (err as Error).message.split("\n")[0]);
      }
    }
  }

  const reason =
    unavailable.get(language) ??
    (isBuiltinLanguage(language) ? "unknown builtin" : "grammar not preloaded");
  throw new GrammarUnavailableError(
    language,
    config?.grammarModule ?? `tree-sitter-${language}`,
    reason,
  );
}

/** True when `language` can be parsed right now without further loading. */
export function isGrammarReady(language: SupportedLanguage): boolean {
  return cache.has(language) || builtinGrammar(language) !== null;
}

/** Test seam: drop all cached parsers and recorded failures. */
export function resetGrammarCache(): void {
  cache.clear();
  unavailable.clear();
}
