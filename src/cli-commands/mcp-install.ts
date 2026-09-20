import { spawnSync } from "child_process";
import path from "path";

interface InstallArgs {
  scope: "local" | "user" | "project";
  /** Repo whose `.codelens/` index the server should serve (local backend). */
  repo?: string;
  neo4jUri?: string;
  neo4jUser?: string;
  neo4jPassword?: string;
  neo4jDatabase?: string;
}

function printInstallHelp(): void {
  console.log(
    `codelens mcp install - register the codelens MCP server with Claude Code

Usage:
  codelens mcp install [options]

Options:
  --scope <local|user|project>   Where to register (default: local)
                                   local   - this directory only
                                   user    - available in all your projects
                                   project - shared via .mcp.json in repo
  --repo <path>                  Serve the local index at <path>/.codelens
                                 (default: current directory). No Neo4j needed.
  --neo4j-uri <uri>              Use a Neo4j backend instead, e.g. bolt://localhost:7687
  --neo4j-user <name>            e.g. neo4j
  --neo4j-password <pw>          e.g. password
  --neo4j-database <name>        (optional) target database
  -h, --help                     Show this help

Without --neo4j-* flags (or NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD env
vars) the server reads the local index written by \`codelens index\`.`,
  );
}

function parseInstallArgs(argv: string[]): InstallArgs {
  const args: InstallArgs = { scope: "local" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--scope": {
        const s = argv[++i];
        if (s !== "local" && s !== "user" && s !== "project") {
          console.error(
            `[codelens] --scope must be local|user|project (got "${s}")`,
          );
          process.exit(2);
        }
        args.scope = s;
        break;
      }
      case "--repo":
        args.repo = path.resolve(argv[++i]);
        break;
      case "--neo4j-uri":
        args.neo4jUri = argv[++i];
        break;
      case "--neo4j-user":
        args.neo4jUser = argv[++i];
        break;
      case "--neo4j-password":
        args.neo4jPassword = argv[++i];
        break;
      case "--neo4j-database":
        args.neo4jDatabase = argv[++i];
        break;
      case "-h":
      case "--help":
        printInstallHelp();
        process.exit(0);
      default:
        console.error(`[codelens] mcp install: unknown arg "${a}"`);
        console.error("[codelens] run 'codelens mcp install --help' for usage");
        process.exit(2);
    }
  }
  args.neo4jUri ??= process.env.NEO4J_URI;
  args.neo4jUser ??= process.env.NEO4J_USER;
  args.neo4jPassword ??= process.env.NEO4J_PASSWORD;
  args.neo4jDatabase ??= process.env.NEO4J_DATABASE;
  return args;
}

function manualConfigSnippet(args: InstallArgs): string {
  const server: Record<string, unknown> = {
    command: "npx",
    args: ["-y", "@marvikomo/codelens-ai", "mcp", ...serverArgs(args)],
  };
  if (args.neo4jUri) {
    const env: Record<string, string> = {
      NEO4J_URI: args.neo4jUri,
      NEO4J_USER: args.neo4jUser ?? "neo4j",
      NEO4J_PASSWORD: args.neo4jPassword ?? "password",
    };
    if (args.neo4jDatabase) env.NEO4J_DATABASE = args.neo4jDatabase;
    server.env = env;
  }
  return JSON.stringify({ mcpServers: { codelens: server } }, null, 2);
}

/** Arguments after `mcp`: the repo to serve when there is no Neo4j. */
function serverArgs(args: InstallArgs): string[] {
  return args.neo4jUri ? [] : ["--repo", args.repo ?? process.cwd()];
}

function ensureClaudeCli(args: InstallArgs): void {
  const r = spawnSync("claude", ["--version"], { stdio: "ignore" });
  if (r.error || r.status !== 0) {
    console.error(
      "[codelens] claude CLI not found on PATH.\n" +
        "Install Claude Code from https://claude.com/claude-code, then re-run.\n" +
        "Or add the server manually by appending this to your MCP config:\n\n" +
        manualConfigSnippet(args),
    );
    process.exit(2);
  }
}

export async function runMcpInstall(argv: string[]): Promise<void> {
  const args = parseInstallArgs(argv);
  ensureClaudeCli(args);

  const cmdArgs: string[] = [
    "mcp",
    "add",
    "codelens",
    "--scope",
    args.scope,
  ];

  if (args.neo4jUri) {
    if (!args.neo4jUser || !args.neo4jPassword) {
      console.error("[codelens] --neo4j-uri needs --neo4j-user and --neo4j-password");
      process.exit(2);
    }
    cmdArgs.push("--env", `NEO4J_URI=${args.neo4jUri}`);
    cmdArgs.push("--env", `NEO4J_USER=${args.neo4jUser}`);
    cmdArgs.push("--env", `NEO4J_PASSWORD=${args.neo4jPassword}`);
    if (args.neo4jDatabase) {
      cmdArgs.push("--env", `NEO4J_DATABASE=${args.neo4jDatabase}`);
    }
  } else {
    const repo = args.repo ?? process.cwd();
    console.error(
      `[codelens] registering the local backend for ${repo}\n` +
        `           (run \`codelens index ${repo}\` first if you haven't)`,
    );
  }

  cmdArgs.push("--", "npx", "-y", "@marvikomo/codelens-ai", "mcp", ...serverArgs(args));

  const r = spawnSync("claude", cmdArgs, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`[codelens] 'claude mcp add' failed (exit ${r.status}).`);
    console.error(
      "If 'codelens' is already registered, remove it first: claude mcp remove codelens",
    );
    process.exit(r.status ?? 1);
  }

  console.error(
    `\n[codelens] registered MCP server "codelens" (scope: ${args.scope}).\n` +
      `Start a new Claude Code session and run /mcp to confirm it appears.`,
  );
}
