import { spawnSync } from "child_process";

const CONTAINER_NAME = "codelens-neo4j";
const IMAGE = "neo4j:5.15";
const VOLUME = "codelens-neo4j-data";
const HTTP_PORT = "7474";
const BOLT_PORT = "7687";
const DEFAULT_PASSWORD = "password";

function ensureDocker(): void {
  const r = spawnSync("docker", ["--version"], { stdio: "ignore" });
  if (r.error || r.status !== 0) {
    console.error(
      "[codelens] docker not found on PATH. Install Docker Desktop from https://docker.com",
    );
    process.exit(2);
  }
}

function getContainerState(): "running" | "stopped" | "absent" {
  const r = spawnSync(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `name=^${CONTAINER_NAME}$`,
      "--format",
      "{{.State}}",
    ],
    { encoding: "utf8" },
  );
  const state = (r.stdout ?? "").trim();
  if (state === "running") return "running";
  if (state === "") return "absent";
  return "stopped";
}

function dockerInherit(args: string[]): number {
  const r = spawnSync("docker", args, { stdio: "inherit" });
  return r.status ?? 1;
}

function printReady(): void {
  console.error(
    `[codelens] neo4j is starting. The DB usually accepts connections in ~10-20s.\n` +
      `  Bolt:    bolt://localhost:${BOLT_PORT}\n` +
      `  Browser: http://localhost:${HTTP_PORT}  (login: neo4j / ${DEFAULT_PASSWORD})\n` +
      `\n` +
      `Next:\n` +
      `  codelens index <repo-path> --neo4j-uri bolt://localhost:${BOLT_PORT} \\\n` +
      `                              --neo4j-user neo4j --neo4j-password ${DEFAULT_PASSWORD} \\\n` +
      `                              --neo4j-clear --cluster`,
  );
}

function start(): void {
  const state = getContainerState();
  if (state === "running") {
    console.error(
      `[codelens] neo4j already running at bolt://localhost:${BOLT_PORT}`,
    );
    return;
  }
  if (state === "stopped") {
    console.error(
      `[codelens] resuming existing container ${CONTAINER_NAME} ...`,
    );
    const code = dockerInherit(["start", CONTAINER_NAME]);
    if (code !== 0) process.exit(code);
    printReady();
    return;
  }
  console.error(`[codelens] creating neo4j container (image: ${IMAGE}) ...`);
  const code = dockerInherit([
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "-p",
    `${HTTP_PORT}:7474`,
    "-p",
    `${BOLT_PORT}:7687`,
    "-e",
    `NEO4J_AUTH=neo4j/${DEFAULT_PASSWORD}`,
    "-e",
    `NEO4J_PLUGINS=["apoc","graph-data-science"]`,
    "-e",
    "NEO4J_dbms_security_procedures_unrestricted=apoc.*,gds.*",
    "-e",
    "NEO4J_dbms_security_procedures_allowlist=apoc.*,gds.*",
    "-v",
    `${VOLUME}:/data`,
    IMAGE,
  ]);
  if (code !== 0) process.exit(code);
  printReady();
}

function stop(): void {
  const state = getContainerState();
  if (state === "absent") {
    console.error(`[codelens] no ${CONTAINER_NAME} container (nothing to stop)`);
    return;
  }
  if (state === "stopped") {
    console.error(`[codelens] neo4j already stopped`);
    return;
  }
  const code = dockerInherit(["stop", CONTAINER_NAME]);
  process.exit(code);
}

function status(): void {
  const state = getContainerState();
  console.error(`[codelens] container ${CONTAINER_NAME}: ${state}`);
  if (state === "running") {
    console.error(`  Bolt:    bolt://localhost:${BOLT_PORT}`);
    console.error(`  Browser: http://localhost:${HTTP_PORT}`);
  } else if (state === "absent") {
    console.error(`  Run 'codelens neo4j start' to create + start it.`);
  } else {
    console.error(`  Run 'codelens neo4j start' to resume.`);
  }
}

function logs(): void {
  const state = getContainerState();
  if (state === "absent") {
    console.error(`[codelens] no ${CONTAINER_NAME} container — nothing to tail`);
    process.exit(2);
  }
  const code = dockerInherit(["logs", "-f", CONTAINER_NAME]);
  process.exit(code);
}

export async function runNeo4jSubcommand(argv: string[]): Promise<void> {
  const action = argv[0];
  if (!action) {
    console.error(
      "[codelens] usage: codelens neo4j <start|stop|status|logs>",
    );
    process.exit(2);
  }
  ensureDocker();
  switch (action) {
    case "start":
      return start();
    case "stop":
      return stop();
    case "status":
      return status();
    case "logs":
      return logs();
    default:
      console.error(`[codelens] unknown neo4j action: ${action}`);
      console.error("[codelens] valid: start | stop | status | logs");
      process.exit(2);
  }
}
