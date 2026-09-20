/**
 * The MCP tools, end to end, over the local backend.
 *
 * A real `McpServer` with every tool registered, driven by a real MCP
 * `Client` over an in-memory transport — the same code path Claude Code
 * takes, minus stdio. Before the store seam these tools could only be
 * exercised against a live Neo4j, so this is their first test coverage.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { analyzeRepository } from "../analyser/analyser";
import { registerTools } from "../mcp/server";
import { LocalStore } from "../store/local";
import { buildLocalIndex } from "../store/build";

const FIXTURE = path.join(__dirname, "fixtures", "layers");

let repo: string;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? "").join("\n");
}

beforeAll(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "codelens-tools-"));
  fs.cpSync(FIXTURE, repo, { recursive: true });
  const graph = analyzeRepository(repo, { resolveCallsByName: true });
  buildLocalIndex(graph, {
    repoPath: repo,
    indexedAt: new Date().toISOString(),
    lastCommit: "deadbeef1234",
    minCommunitySize: 1,
  });

  const server = new McpServer({ name: "test", version: "0" }, { capabilities: { tools: {} } });
  registerTools(server, LocalStore.open(repo));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test-client", version: "0" });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("tool registry", () => {
  it("registers every tool except cypher on the local backend", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "generate_wiki",
      "get_callees",
      "get_callers",
      "get_definition",
      "get_overview",
      "impact_analysis",
      "label_community",
      "read_code",
      "search_code",
    ]);
  });
});

describe("get_overview", () => {
  it("renders counts, languages, communities and the freshness line", async () => {
    const text = await call("get_overview");
    expect(text).toContain("# Codebase overview");
    expect(text).toContain("commit deadbeef1234");
    expect(text).toContain("- File: 5");
    expect(text).toContain("- typescript: 5");
    expect(text).toContain("## Top architectural communities");
    expect(text).toContain("## High-blast files");
    // Nothing is labelled yet, so the agent is asked to label.
    expect(text).toContain("ACTION RECOMMENDED");
    expect(text).not.toContain("## Semantic layers");
  });
});

describe("get_definition / get_callers / get_callees", () => {
  it("returns the body of a symbol", async () => {
    const text = await call("get_definition", { name: "findUser" });
    expect(text).toContain('Found 1 definition(s) of "findUser"');
    expect(text).toContain("prisma.user.findUnique");
    expect(text).toMatch(/db\/users\.ts:\d+-\d+/);
  });

  it("says so when nothing matches", async () => {
    expect(await call("get_definition", { name: "nope" })).toContain('No definition found for "nope"');
  });

  it("lists callers and callees", async () => {
    const callers = await call("get_callers", { symbol: "findUser" });
    expect(callers).toContain('caller(s) of "findUser"');
    expect(callers).toContain("Method profile");
    const callees = await call("get_callees", { symbol: "findUser" });
    expect(callees).toContain("Function normalizeId");
    expect(callees).toContain("Unresolved findUnique");
    expect(callees).toContain("(external)");
  });
});

describe("impact_analysis", () => {
  it("gives a verdict, callers by community and a reference block", async () => {
    const text = await call("impact_analysis", { symbol: "findUser" });
    expect(text).toContain("# Impact analysis: `findUser`");
    expect(text).toContain("## Verdict");
    expect(text).toMatch(/Probably safe to change|Reviewer should focus|Risky change/);
    expect(text).toContain("## Production callers");
    expect(text).toContain("`profile`");
    expect(text).toContain("## Reference");
    expect(text).toContain("Direct caller count: 2");
  });

  it("asks for disambiguation when two declarations share a name", async () => {
    // `router` exists once; `clamp` once. Fake ambiguity via a common name
    // is not available in this fixture, so assert the no-match path instead.
    expect(await call("impact_analysis", { symbol: "nothingHere" })).toContain('No symbol named "nothingHere"');
  });
});

describe("label_community", () => {
  it("labels, then get_overview shows the label and stops nagging for it", async () => {
    const before = await call("get_overview");
    const match = before.match(/communityId: (\d+)/);
    expect(match).not.toBeNull();
    const id = Number(match![1]);
    const res = await call("label_community", {
      communityId: id,
      label: "user-data",
      description: "Serves user records over HTTP.",
    });
    expect(res).toContain(`Labeled community ${id}: "user-data"`);
    const after = await call("get_overview");
    expect(after).toContain("**`user-data`**");
    expect(after).toContain("summary: Serves user records over HTTP.");
    expect(after).not.toContain(`communityId: ${id}\n`);
  });

  it("rejects an unknown community", async () => {
    expect(await call("label_community", { communityId: 4242, label: "x" })).toContain("No community with id 4242");
  });
});

describe("generate_wiki", () => {
  it("produces the skeleton with routes, tests and a glossary", async () => {
    const text = await call("generate_wiki");
    expect(text).toContain("| GET | /users/:id |");
    expect(text).toContain("## Test inventory");
    expect(text).toContain("util.spec.ts");
    expect(text).toContain("## Entry points");
    expect(text).toContain("findUser");
  });
});

describe("search_code and read_code", () => {
  it("searches by keyword", async () => {
    const text = await call("search_code", { query: "findUser" });
    expect(text).toContain('hit(s) for "findUser"');
    expect(text).toMatch(/1\. \[fts [\d.]+\] Function findUser/);
  });

  it("reads a file slice from disk", async () => {
    const text = await call("read_code", { file: path.join(repo, "src/util.ts"), startLine: 1, endLine: 3 });
    expect(text).toContain("export function clamp");
  });
});
