import type { LanguageConfig } from "../language-config";
import { python } from "./python";
import { go } from "./go";
import { rust } from "./rust";
import { ruby } from "./ruby";
import { csharp } from "./csharp";
import { php } from "./php";
import { scala } from "./scala";
import { groovy } from "./groovy";
import { c, cpp } from "./c";
import { objc } from "./objc";
import { kotlin } from "./kotlin";
import { swift } from "./swift";
import { elixir } from "./elixir";
import { julia } from "./julia";
import { powershell } from "./powershell";
import { ocaml } from "./ocaml";
import { commonlisp } from "./commonlisp";
import { dm } from "./dm";
import { bash } from "./bash";

/**
 * Languages served by the config-driven `GenericExtractor`.
 *
 * JS/TS/TSX and Java are absent on purpose — they keep their hand-written
 * extractors, which model more than this generic path does.
 *
 * Every entry here was checked against the real grammar before being written:
 * node-type names come from dumping actual parse trees, not from assumption.
 * Grammars that do not load against tree-sitter 0.25 (the NAN-era lua, zig,
 * verilog, dart, sql and vue packages) are deliberately not listed, because a
 * config for a grammar that cannot load is a language we would claim and not
 * deliver.
 */
export const LANGUAGE_CONFIGS: Readonly<Record<string, LanguageConfig>> = {
  python,
  go,
  rust,
  ruby,
  csharp,
  php,
  scala,
  groovy,
  c,
  cpp,
  objc,
  kotlin,
  swift,
  elixir,
  julia,
  powershell,
  ocaml,
  commonlisp,
  dm,
  bash,
};

export type ConfigLanguage = keyof typeof LANGUAGE_CONFIGS;
