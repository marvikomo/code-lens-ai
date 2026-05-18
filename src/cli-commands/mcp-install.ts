import { spawnSync } from "child_process";

interface InstallArgs {
  scope: "local" | "user" | "project";
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
  --neo4j-uri <uri>              e.g. bolt://localhost:7687
  --neo4j-user <name>            e.g. neo4j
  --neo4j-password <pw>          e.g. password
  --neo4j-database <name>        (optional) target database
  -h, --help                     Show this help

If --neo4j-* flags are omitted, falls back to NEO4J_URI / NEO4J_USER /
NEO4J_PASSWORD / NEO4J_DATABASE env vars. If none are set, registration
still completes but the server will fail at runtime until credentials
are available.`,
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
  const env: Record<string, string> = {
    NEO4J_URI: args.neo4jUri ?? "bolt://localhost:7687",
    NEO4J_USER: args.neo4jUser ?? "neo4j",
    NEO4J_PASSWORD: args.neo4jPassword ?? "password",
  };
  if (args.neo4jDatabase) env.NEO4J_DATABASE = args.neo4jDatabase;
  const json = JSON.stringify(
    {
      mcpServers: {
        codelens: {
          command: "npx",
          args: ["-y", "@marvikomo/codelens-ai", "mcp"],
          env,
        },
      },
    },
    null,
    2,
  );
  return json;
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

  const haveCreds =
    args.neo4jUri && args.neo4jUser && args.neo4jPassword;
  if (haveCreds) {
    cmdArgs.push("--env", `NEO4J_URI=${args.neo4jUri}`);
    cmdArgs.push("--env", `NEO4J_USER=${args.neo4jUser}`);
    cmdArgs.push("--env", `NEO4J_PASSWORD=${args.neo4jPassword}`);
    if (args.neo4jDatabase) {
      cmdArgs.push("--env", `NEO4J_DATABASE=${args.neo4jDatabase}`);
    }
  } else {
    console.error(
      "[codelens] warning: no Neo4j credentials provided. The MCP server will fail " +
        "to start until you set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD in your shell " +
        "env, or re-install with:\n" +
        "  codelens mcp install --neo4j-uri bolt://localhost:7687 \\\n" +
        "                       --neo4j-user neo4j --neo4j-password password",
    );
  }

  cmdArgs.push("--", "npx", "-y", "@marvikomo/codelens-ai", "mcp");

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
