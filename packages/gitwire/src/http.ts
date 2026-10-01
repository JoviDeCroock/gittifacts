/**
 * Smart HTTP transport and ref discovery.
 * See git Documentation/gitprotocol-http.txt "Smart Clients" / "Smart Service git-upload-pack",
 * gitprotocol-pack.txt "Reference Discovery" (v0/v1) and gitprotocol-v2.txt "ls-refs".
 */
import { type Bytes, base64, isSha, own, ZERO_SHA } from "./bytes.js";
import { GitHttpError, GitProtocolError } from "./errors.js";
import { DELIM, encodeLines, FLUSH, payloadsUntilFlush, pktText, readPktLines } from "./pktline.js";

export type GitAuth = { bearer: string } | { basic: { username: string; password: string } };

export interface GitRemote {
  /** Repository URL ending in `.git`, e.g. `https://<acct>.artifacts.cloudflare.net/git/ns/repo.git`. */
  url: string;
  auth?: GitAuth;
  /** Custom fetch (service bindings, tests). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export type GitService = "git-upload-pack" | "git-receive-pack";

/** Sent as `agent=` (gitprotocol-capabilities.txt "agent"); also the User-Agent prefix. */
export const AGENT = "gittifacts/0";

/**
 * One smart-HTTP exchange. Without a body: GET `info/refs?service=…` (the v1 ref advertisement or
 * the v2 capability advertisement). With a body: POST a stateless RPC request to `/<service>`.
 */
export async function request(
  remote: GitRemote,
  service: GitService,
  v2: boolean,
  body?: Uint8Array,
): Promise<Bytes> {
  const type = `application/x-${service}-${body ? "result" : "advertisement"}`;
  // Some hosts only speak the smart protocol to user agents starting with "git/".
  const headers = new Headers({ "User-Agent": `git/${AGENT}`, Accept: type });
  if (body) headers.set("Content-Type", `application/x-${service}-request`);
  if (v2) headers.set("Git-Protocol", "version=2");
  const auth = remote.auth;
  if (auth && "bearer" in auth) headers.set("Authorization", `Bearer ${auth.bearer}`);
  else if (auth)
    headers.set(
      "Authorization",
      `Basic ${base64(`${auth.basic.username}:${auth.basic.password}`)}`,
    );
  const path = body ? service : `info/refs?service=${service}`;
  const init: RequestInit = { method: body ? "POST" : "GET", headers };
  if (body) init.body = own(body);
  const res = await (remote.fetch ?? fetch)(`${remote.url.replace(/\/+$/, "")}/${path}`, init);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const snippet = new TextDecoder().decode(bytes.subarray(0, 512));
  if (!res.ok)
    throw new GitHttpError(res.status, `${init.method} ${path}: HTTP ${res.status}`, snippet);
  // gitprotocol-http.txt: clients MUST check the Content-Type of smart responses.
  const ct = res.headers.get("Content-Type");
  if (ct && !ct.startsWith(type)) {
    throw new GitHttpError(res.status, `${path}: expected ${type}, got ${ct}`, snippet);
  }
  return bytes;
}

/** Refs → SHA. Peeled tags appear as `refs/tags/x^{}` (like `git ls-remote`). */
export type RefMap = Map<string, string> & {
  /** Symbolic refs, e.g. HEAD → refs/heads/main. */
  symrefs: Map<string, string>;
  /** Server capabilities (v1 list from the first ref line, or v2 advertisement keys/values). */
  capabilities: Set<string>;
  protocol: 1 | 2;
};

export interface ListRefsOptions {
  /** 2 (default) uses `ls-refs` when the server speaks v2 and falls back to v1 otherwise. */
  protocol?: 1 | 2;
  /** Only return refs starting with one of these (HEAD is matched by "HEAD"). */
  prefixes?: string[];
  /** `git-receive-pack` returns the push advertisement (always v1), incl. its capabilities. */
  service?: GitService;
}

function refMap(protocol: 1 | 2): RefMap {
  return Object.assign(new Map<string, string>(), {
    symrefs: new Map<string, string>(),
    capabilities: new Set<string>(),
    protocol,
  });
}

/** Advertisement payloads, minus the "# service=<name>" line + flush smart HTTP prepends. */
function advertisedLines(buf: Uint8Array): Bytes[] {
  const lines = [...readPktLines(buf)];
  const first = lines[0];
  if (first?.type === "data" && pktText(first.data).startsWith("# service=")) {
    lines.splice(0, lines[1]?.type === "flush" ? 2 : 1); // gitprotocol-http.txt "Smart Clients"
  }
  return payloadsUntilFlush(lines);
}

/** gitprotocol-pack.txt "Reference Discovery": `<sha> <ref>[\0<caps>]` lines. */
function parseV1(lines: Bytes[], out: RefMap): void {
  for (const [i, raw] of lines.entries()) {
    let line = pktText(raw);
    if (i === 0) {
      const nul = line.indexOf("\0");
      if (nul >= 0) {
        for (const cap of line.slice(nul + 1).split(" ")) {
          if (!cap) continue;
          out.capabilities.add(cap);
          const m = /^symref=([^:]+):(.+)$/.exec(cap);
          if (m) out.symrefs.set(m[1]!, m[2]!);
        }
        line = line.slice(0, nul);
      }
    }
    if (line.startsWith("shallow ")) continue;
    const [sha, ref] = line.split(" ");
    if (!sha || !ref || !isSha(sha)) throw new GitProtocolError(`bad ref line: ${line}`);
    // An empty repo advertises `<zero-id> capabilities^{}` just to carry the capability list.
    if (ref === "capabilities^{}" && sha === ZERO_SHA) continue;
    out.set(ref, sha);
  }
}

/** Lists remote refs. v2 sends `ls-refs` with `peel` + `symrefs`; v1 parses the advertisement. */
export async function listRefs(remote: GitRemote, opts: ListRefsOptions = {}): Promise<RefMap> {
  const service = opts.service ?? "git-upload-pack";
  // receive-pack is v1 only on Artifacts (and in git itself), so never ask it for v2.
  const wantV2 = opts.protocol !== 1 && service === "git-upload-pack";
  const adv = advertisedLines(await request(remote, service, wantV2));
  let refs: RefMap;
  if (wantV2 && adv[0] && pktText(adv[0]) === "version 2") {
    refs = refMap(2);
    for (const cap of adv.slice(1)) refs.capabilities.add(pktText(cap));
    const args = ["peel\n", "symrefs\n", ...(opts.prefixes ?? []).map((p) => `ref-prefix ${p}\n`)];
    const body = encodeLines(["command=ls-refs\n", `agent=${AGENT}\n`, DELIM, ...args, FLUSH]);
    // gitprotocol-v2.txt "ls-refs": `<oid> <ref>[ symref-target:<t>][ peeled:<oid>]`.
    const res = await request(remote, "git-upload-pack", true, body);
    for (const raw of payloadsUntilFlush(readPktLines(res))) {
      const [sha, ref, ...attrs] = pktText(raw).split(" ");
      if (!sha || !ref || !isSha(sha))
        throw new GitProtocolError(`bad ls-refs line: ${pktText(raw)}`);
      refs.set(ref, sha);
      for (const a of attrs) {
        if (a.startsWith("symref-target:")) refs.symrefs.set(ref, a.slice(14));
        else if (a.startsWith("peeled:")) refs.set(`${ref}^{}`, a.slice(7));
      }
    }
  } else {
    refs = refMap(1);
    parseV1(adv, refs);
  }
  const prefixes = opts.prefixes;
  if (prefixes) {
    for (const ref of [...refs.keys()]) {
      if (!prefixes.some((p) => ref.startsWith(p))) refs.delete(ref);
    }
  }
  return refs;
}
