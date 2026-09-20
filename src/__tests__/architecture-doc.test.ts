/**
 * Keeps ARCHITECTURE.md honest.
 *
 * Documentation that describes module boundaries rots the moment someone
 * renames an entry point, and a stale architecture doc is worse than none —
 * it sends readers to symbols that no longer exist. Importing every symbol the
 * doc names turns that drift into a failing test. The idea is borrowed from
 * graphify, whose architecture doc is pinned the same way.
 *
 * If you rename something here, update the doc in the same change.
 */
import fs from "fs";
import path from "path";

// Every symbol the module table in ARCHITECTURE.md names.
import { detectLanguage, supportedExtensions } from "../util/language";
import { preloadGrammars, getParser } from "../util/parserFactory";
import { GenericExtractor } from "../extractor/generic";
import { JsTsExtractor } from "../extractor/jsts";
import { JavaExtractor } from "../extractor/java";
import {
  analyzeRepository,
  analyzeIncremental,
  preloadRepositoryGrammars,
} from "../analyser/analyser";
import { indexToNeo4j } from "../indexers/neo4j";
import { clusterInNeo4j } from "../clustering/neo4j-leiden";
import { computeFileMetrics, heuristicLabelFor } from "../clustering/graph-metrics";
import { buildLocalIndex } from "../store/build";
import { LocalStore } from "../store/local";
import { Neo4jStore } from "../store/neo4j";
import { openStore } from "../store";
import { startMcpServer, registerTools } from "../mcp/server";
import {
  installHooks,
  uninstallHooks,
  hooksStatus,
} from "../cli-commands/hooks";
import { LANGUAGE_CONFIGS } from "../extractor/configs";
import { tagFileLayers } from "../ai/layers";
import { createJudge } from "../ai/judge";

const DOC = fs.readFileSync(
  path.join(__dirname, "..", "..", "ARCHITECTURE.md"),
  "utf8",
);

describe("ARCHITECTURE.md", () => {
  it("names only symbols that exist", () => {
    const symbols: Record<string, unknown> = {
      detectLanguage,
      supportedExtensions,
      preloadGrammars,
      getParser,
      GenericExtractor,
      JsTsExtractor,
      JavaExtractor,
      analyzeRepository,
      analyzeIncremental,
      preloadRepositoryGrammars,
      indexToNeo4j,
      clusterInNeo4j,
      computeFileMetrics,
      heuristicLabelFor,
      buildLocalIndex,
      LocalStore,
      Neo4jStore,
      openStore,
      startMcpServer,
      registerTools,
      installHooks,
      uninstallHooks,
      hooksStatus,
      tagFileLayers,
      createJudge,
    };
    for (const [name, value] of Object.entries(symbols)) {
      expect(value).toBeDefined();
      // And the doc must actually mention it, so the list cannot silently
      // drift out of the prose either.
      expect(DOC).toContain(name);
    }
  });

  it("lists the EdgeSource confidence tiers the resolver emits", () => {
    for (const tier of [
      "static",
      "via_imports",
      "via_reexport",
      "name_only",
      "name_only_ambiguous",
      "dynamic",
    ]) {
      expect(DOC).toContain(tier);
    }
  });

  it("points at directories that exist", () => {
    const root = path.join(__dirname, "..", "..");
    for (const dir of [
      "src/extractor/configs",
      "src/clustering",
      "src/mcp/tools",
      "src/cli-commands",
      "src/indexers",
    ]) {
      expect(DOC).toContain(dir.replace("src/", ""));
      expect(fs.existsSync(path.join(root, dir))).toBe(true);
    }
  });

  it("does not claim more config-driven languages than are registered", () => {
    // Guards the "adding a language is normally a config object" claim.
    expect(Object.keys(LANGUAGE_CONFIGS).length).toBeGreaterThanOrEqual(20);
  });
});
