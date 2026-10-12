/**
 * A repo's code and history (apps/platform/src/routes/code.ts): `GET /api/v1/repos/:repoId/`
 * `tree`, `file`, `raw`, `commits`, `commits/:sha` and `activity`, each at a ref (default: the
 * default branch). In mock mode an in-browser repo answers (mock-code.ts).
 */
import type {
  CodeFileResponse,
  CodeTree,
  CommitActivity,
  CommitDetail,
  CommitLog,
} from "@app/domain";
import { request } from "./client.js";
import { isMockMode } from "./mode.js";

export type { CodeFileResponse, CodeTree, CommitActivity, CommitDetail, CommitLog };

const enc = encodeURIComponent;

function q(params: Record<string, string | number | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
}

async function get<T>(path: string): Promise<T> {
  if (!isMockMode()) return request<T>("GET", path);
  const mock = await import("./mock-code.js");
  return mock.handle(path) as Promise<T>;
}

const base = (repoId: string) => `/api/v1/repos/${enc(repoId)}`;

export const codeApi = {
  tree: (repoId: string, path: string, ref?: string) =>
    get<CodeTree>(`${base(repoId)}/tree${q({ path, ref })}`),
  file: (repoId: string, path: string, ref?: string) =>
    get<CodeFileResponse>(`${base(repoId)}/file${q({ path, ref })}`),
  commits: (repoId: string, opts: { ref?: string; offset?: number; limit?: number } = {}) =>
    get<CommitLog>(`${base(repoId)}/commits${q(opts)}`),
  commit: (repoId: string, sha: string) => get<CommitDetail>(`${base(repoId)}/commits/${enc(sha)}`),
  activity: (repoId: string, opts: { ref?: string; weeks?: number } = {}) =>
    get<CommitActivity>(`${base(repoId)}/activity${q(opts)}`),
};

/** The raw file's URL (images inline, text, or a download); not served in mock mode. */
export function rawUrl(repoId: string, path: string, ref?: string): string | null {
  return isMockMode() ? null : `${base(repoId)}/raw${q({ path, ref })}`;
}
