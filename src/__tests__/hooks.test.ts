/**
 * Git-hook install/uninstall.
 *
 * The incremental indexer already existed; nothing triggered it, so an index
 * went stale the moment you committed. These hooks are the trigger.
 *
 * The behaviour under test that matters most is not installing — it is not
 * destroying. Someone's pre-existing hook script must survive both install and
 * uninstall, because silently clobbering a repo's git tooling to add an
 * indexer is a far worse outcome than a stale graph.
 */
import fs from "fs";
import os from "os";
import path from "path";
import {
  installHooks,
  uninstallHooks,
  hooksStatus,
} from "../cli-commands/hooks";

let repo: string;

const hookPath = (name: string): string =>
  path.join(repo, ".git", "hooks", name);

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "codelens-hooks-"));
  // A bare .git directory is enough for isGitRepo.
  fs.mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("install", () => {
  it("installs every lifecycle hook", () => {
    const { installed } = installHooks({ repo });
    expect(installed).toEqual([
      "post-commit",
      "post-checkout",
      "post-merge",
      "post-rewrite",
    ]);
    for (const hook of installed) {
      expect(fs.existsSync(hookPath(hook))).toBe(true);
    }
  });

  it("makes the hook executable", () => {
    installHooks({ repo });
    const mode = fs.statSync(hookPath("post-commit")).mode;
    expect(mode & 0o111).toBeTruthy();
  });

  it("never lets re-indexing fail a git operation", () => {
    installHooks({ repo, command: "codelens" });
    const body = fs.readFileSync(hookPath("post-commit"), "utf8");
    // Detached, output discarded, and `|| true` so a non-zero exit cannot
    // abort the commit.
    expect(body).toContain("&");
    expect(body).toContain("|| true");
    expect(body).toContain("--incremental");
  });

  it("is idempotent — a second install does not duplicate the block", () => {
    installHooks({ repo, command: "codelens" });
    installHooks({ repo, command: "codelens" });
    const body = fs.readFileSync(hookPath("post-commit"), "utf8");
    expect(body.split("codelens managed block").length - 1).toBe(2); // one begin, one end
  });
});

describe("preserving existing hooks", () => {
  const existing = "#!/bin/sh\necho \"my important hook\"\nexit 0\n";

  it("appends to a hand-written hook instead of replacing it", () => {
    fs.writeFileSync(hookPath("post-commit"), existing, { mode: 0o755 });
    installHooks({ repo, command: "codelens" });
    const body = fs.readFileSync(hookPath("post-commit"), "utf8");
    expect(body).toContain("my important hook");
    expect(body).toContain("--incremental");
  });

  it("removes only its own block on uninstall", () => {
    fs.writeFileSync(hookPath("post-commit"), existing, { mode: 0o755 });
    installHooks({ repo, command: "codelens" });
    uninstallHooks({ repo });
    const body = fs.readFileSync(hookPath("post-commit"), "utf8");
    expect(body).toContain("my important hook");
    expect(body).not.toContain("--incremental");
    expect(body).not.toContain("codelens managed block");
  });

  it("deletes a hook file it created outright", () => {
    installHooks({ repo, command: "codelens" });
    uninstallHooks({ repo });
    // Nothing but our block was ever in it, so no inert stub is left behind.
    expect(fs.existsSync(hookPath("post-commit"))).toBe(false);
  });
});

describe("status", () => {
  it("reports what is installed", () => {
    expect(hooksStatus(repo).every((h) => !h.present)).toBe(true);
    installHooks({ repo, command: "codelens" });
    expect(hooksStatus(repo).every((h) => h.present)).toBe(true);
  });
});

describe("guards", () => {
  it("refuses a directory that is not a git repository", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "codelens-plain-"));
    try {
      expect(() => installHooks({ repo: plain })).toThrow(/Not a git repository/);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
