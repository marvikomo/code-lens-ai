import fs from "fs";
import path from "path";
import { isGitRepo } from "../util/git";

/**
 * Git hooks that keep the index fresh.
 *
 * The expensive half of automatic freshness already existed — `--incremental`
 * diffs content hashes and re-extracts only what changed. What was missing was
 * anything to trigger it, so an index went stale the moment you committed and
 * the only signal was a staleness warning at query time.
 *
 * Hooks that change what is on disk: a commit, a branch switch, a merge, and a
 * rebase/amend. `git pull` fires post-merge, so that is covered too.
 */
const HOOKS = [
  "post-commit",
  "post-checkout",
  "post-merge",
  "post-rewrite",
] as const;

const BEGIN = "# >>> codelens managed block >>>";
const END = "# <<< codelens managed block <<<";

export interface HooksOptions {
  /** Repository to install into. */
  readonly repo: string;
  /** Command used to re-index. Defaults to the running CLI. */
  readonly command?: string;
}

export interface HooksResult {
  readonly installed: string[];
  readonly skipped: { hook: string; reason: string }[];
}

function hooksDir(repo: string): string {
  return path.join(path.resolve(repo), ".git", "hooks");
}

/**
 * Re-index in the background and never fail the git operation.
 *
 * A hook that blocks a commit on an indexer, or fails it when the indexer
 * errors, is a hook people delete. `|| true` plus detachment keeps git's
 * behaviour unchanged whatever happens here.
 */
function blockFor(command: string, repo: string): string {
  return [
    BEGIN,
    "# Keeps the code graph in sync. Re-indexing runs detached and its exit",
    "# status is discarded, so this can never block or fail a git operation.",
    `( ${command} ${JSON.stringify(path.resolve(repo))} --incremental --no-json >/dev/null 2>&1 & ) || true`,
    END,
  ].join("\n");
}

/** Strip a previously-installed block, leaving any hand-written hook intact. */
function withoutBlock(contents: string): string {
  const start = contents.indexOf(BEGIN);
  if (start === -1) return contents;
  const end = contents.indexOf(END);
  if (end === -1 || end < start) return contents;
  const before = contents.slice(0, start);
  const after = contents.slice(end + END.length);
  return `${before.replace(/\n+$/, "\n")}${after.replace(/^\n+/, "")}`;
}

function defaultCommand(): string {
  // Resolve to the CLI actually running, so a locally-linked checkout does not
  // silently invoke a different globally-installed copy.
  const entry = require.main?.filename;
  return entry ? `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)}` : "codelens";
}

/**
 * Install (or refresh) the managed block in each hook.
 *
 * An existing hook is appended to, never replaced — clobbering someone's
 * pre-commit tooling to install an indexer is not a trade worth making. A
 * re-run replaces only our own block.
 */
export function installHooks(opts: HooksOptions): HooksResult {
  const repo = path.resolve(opts.repo);
  if (!isGitRepo(repo)) {
    throw new Error(`Not a git repository: ${repo}`);
  }

  const dir = hooksDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  const command = opts.command ?? defaultCommand();
  const block = blockFor(command, repo);

  const installed: string[] = [];
  const skipped: { hook: string; reason: string }[] = [];

  for (const hook of HOOKS) {
    const file = path.join(dir, hook);
    let existing = "";
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch {
      existing = "";
    }

    try {
      if (!existing.trim()) {
        fs.writeFileSync(file, `#!/bin/sh\n${block}\n`, { mode: 0o755 });
      } else {
        const base = withoutBlock(existing).replace(/\n*$/, "\n");
        fs.writeFileSync(file, `${base}${block}\n`, { mode: 0o755 });
      }
      fs.chmodSync(file, 0o755);
      installed.push(hook);
    } catch (err) {
      skipped.push({ hook, reason: (err as Error).message });
    }
  }

  return { installed, skipped };
}

/** Remove the managed block, leaving any surrounding hook script in place. */
export function uninstallHooks(opts: Pick<HooksOptions, "repo">): HooksResult {
  const repo = path.resolve(opts.repo);
  if (!isGitRepo(repo)) {
    throw new Error(`Not a git repository: ${repo}`);
  }

  const dir = hooksDir(repo);
  const installed: string[] = [];
  const skipped: { hook: string; reason: string }[] = [];

  for (const hook of HOOKS) {
    const file = path.join(dir, hook);
    let existing: string;
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch {
      skipped.push({ hook, reason: "not present" });
      continue;
    }
    if (!existing.includes(BEGIN)) {
      skipped.push({ hook, reason: "no codelens block" });
      continue;
    }

    const remaining = withoutBlock(existing);
    // If nothing but the shebang is left, the file was ours — remove it rather
    // than leaving an inert stub behind.
    if (remaining.replace(/^#!.*\n?/, "").trim() === "") {
      fs.unlinkSync(file);
    } else {
      fs.writeFileSync(file, remaining, { mode: 0o755 });
    }
    installed.push(hook);
  }

  return { installed, skipped };
}

/** Which hooks currently carry the managed block. */
export function hooksStatus(repo: string): { hook: string; present: boolean }[] {
  const dir = hooksDir(path.resolve(repo));
  return HOOKS.map((hook) => {
    try {
      return {
        hook,
        present: fs.readFileSync(path.join(dir, hook), "utf8").includes(BEGIN),
      };
    } catch {
      return { hook, present: false };
    }
  });
}

/** `codelens hooks install|uninstall|status [path]` */
export async function runHooksSubcommand(argv: string[]): Promise<void> {
  const action = argv[0] ?? "status";
  const repo = argv[1] ?? process.cwd();

  if (action === "install") {
    const { installed, skipped } = installHooks({ repo });
    console.error(`[codelens] installed hooks: ${installed.join(", ") || "none"}`);
    for (const s of skipped) {
      console.error(`[codelens] skipped ${s.hook}: ${s.reason}`);
    }
    console.error(
      "[codelens] the index now refreshes after commit, checkout, merge and rebase",
    );
    return;
  }

  if (action === "uninstall") {
    const { installed } = uninstallHooks({ repo });
    console.error(`[codelens] removed hooks: ${installed.join(", ") || "none"}`);
    return;
  }

  if (action === "status") {
    for (const { hook, present } of hooksStatus(repo)) {
      console.error(`[codelens] ${hook}: ${present ? "installed" : "not installed"}`);
    }
    return;
  }

  console.error(`Unknown hooks action: ${action}`);
  console.error("Usage: codelens hooks install|uninstall|status [repo-path]");
  process.exit(1);
}
