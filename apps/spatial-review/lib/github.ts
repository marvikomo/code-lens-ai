/**
 * Thin GitHub REST API client. PAT-based for the prototype; OAuth replaces
 * this once we go hosted. Server-side only — never expose the token to the
 * browser.
 *
 * Uses fetch (Node 20+ runtime) + an Accept header that pins the API version
 * so behavior doesn't drift if GitHub ships breaking changes.
 */

const GITHUB_API = "https://api.github.com";

export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string; // owner/repo
  owner: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  language: string | null;
  stargazersCount: number;
  pushedAt: string;
}

export interface GitHubPr {
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  user: string;
  htmlUrl: string;
  baseSha: string;
  headSha: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  createdAt: string;
  updatedAt: string;
}

function authHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN not set. Copy .env.local.example to .env.local and add a token from https://github.com/settings/tokens (classic, repo scope).",
    );
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Lists repos the authenticated user owns or is a collaborator on. */
export async function listMyRepos(): Promise<GitHubRepo[]> {
  // GET /user/repos returns affiliated repos (owner + collaborator + org member).
  // Default per_page is 30; bump to 100 to fit one screen for most users.
  // Pagination: not implemented yet — first 100 is enough for the prototype.
  const res = await fetch(
    `${GITHUB_API}/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member`,
    { headers: authHeaders(), cache: "no-store" },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub /user/repos failed: ${res.status} — ${body.slice(0, 200)}`);
  }
  const raw = (await res.json()) as Array<Record<string, unknown>>;
  return raw.map(mapRepo);
}

export interface PrFile {
  /** Repo-relative path (forward slashes, no leading slash). */
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed";
  additions: number;
  deletions: number;
  changes: number;
  /** Set on renames; the old path. */
  previousFilename?: string;
}

/** Lists files changed in a PR (no diff content; just metadata). */
export async function listPrFiles(
  owner: string,
  repo: string,
  number: number,
): Promise<PrFile[]> {
  // GitHub paginates this at 30/page by default; we bump to 100 and follow
  // pagination via the Link header. For most PRs even 100 is enough; very
  // large PRs (>100 files changed) we paginate.
  const all: PrFile[] = [];
  let url:
    | string
    | null = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`;
  while (url) {
    const res: Response = await fetch(url, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `GitHub /pulls/${number}/files failed: ${res.status} — ${body.slice(0, 200)}`,
      );
    }
    const raw = (await res.json()) as Array<Record<string, unknown>>;
    for (const f of raw) {
      all.push({
        filename: String(f.filename),
        status: String(f.status) as PrFile["status"],
        additions: Number(f.additions ?? 0),
        deletions: Number(f.deletions ?? 0),
        changes: Number(f.changes ?? 0),
        previousFilename:
          typeof f.previous_filename === "string"
            ? f.previous_filename
            : undefined,
      });
    }
    // Follow GitHub's Link: <...>; rel="next" pagination.
    url = parseNextLink(res.headers.get("link"));
    if (all.length >= 500) break; // safety cap — no real PR is bigger
  }
  return all;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  // Format: <url1>; rel="next", <url2>; rel="prev"
  for (const part of linkHeader.split(",")) {
    const m = part.trim().match(/^<([^>]+)>;\s*rel="next"$/);
    if (m) return m[1];
  }
  return null;
}

/** Lists open PRs for a repo. */
export async function listOpenPrs(
  owner: string,
  repo: string,
): Promise<GitHubPr[]> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=open&per_page=50&sort=updated&direction=desc`,
    { headers: authHeaders(), cache: "no-store" },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub /repos/${owner}/${repo}/pulls failed: ${res.status} — ${body.slice(0, 200)}`,
    );
  }
  const raw = (await res.json()) as Array<Record<string, unknown>>;
  return raw.map(mapPr);
}

function mapRepo(r: Record<string, unknown>): GitHubRepo {
  const owner = r.owner as { login: string } | undefined;
  return {
    id: Number(r.id),
    name: String(r.name),
    fullName: String(r.full_name),
    owner: owner?.login ?? "",
    description: (r.description as string | null) ?? null,
    isPrivate: Boolean(r.private),
    defaultBranch: String(r.default_branch ?? "main"),
    htmlUrl: String(r.html_url),
    cloneUrl: String(r.clone_url),
    language: (r.language as string | null) ?? null,
    stargazersCount: Number(r.stargazers_count ?? 0),
    pushedAt: String(r.pushed_at),
  };
}

function mapPr(p: Record<string, unknown>): GitHubPr {
  const user = p.user as { login: string } | undefined;
  const head = p.head as { sha: string } | undefined;
  const base = p.base as { sha: string } | undefined;
  return {
    number: Number(p.number),
    title: String(p.title),
    state: (p.state as "open" | "closed") ?? "open",
    draft: Boolean(p.draft),
    user: user?.login ?? "",
    htmlUrl: String(p.html_url),
    baseSha: base?.sha ?? "",
    headSha: head?.sha ?? "",
    // Per-PR detail fields. The list endpoint sometimes returns these,
    // sometimes nulls. Coerce to 0 to avoid undefined surprises in UI.
    changedFiles: Number(p.changed_files ?? 0),
    additions: Number(p.additions ?? 0),
    deletions: Number(p.deletions ?? 0),
    createdAt: String(p.created_at),
    updatedAt: String(p.updated_at),
  };
}
