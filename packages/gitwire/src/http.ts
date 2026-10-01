/**
 * Smart HTTP transport and ref discovery.
 * See git Documentation/gitprotocol-http.txt "Smart Clients" / "Smart Service git-upload-pack",
 * gitprotocol-pack.txt "Reference Discovery" (v0/v1) and gitprotocol-v2.txt "ls-refs".
 */
import { type Bytes, ZERO_SHA, base64, isSha, own } from "./bytes.js";
import { GitHttpError, GitProtocolError } from "./errors.js";
import {
  DELIM,
  FLUSH,
  encodeLines,
  payloadsUntilFlush,
  pktText,
  readPktLines,
  throwIfErr,
} from "./pktline.js";

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

function headers(remote: GitRemote, extra: Record<string, string>): Headers {
  // Some hosts only speak the smart protocol to user agents starting with "git/".
  const h = new Headers({ "User-Agent": `git/${AGENT}`, ...extra });
  if (remote.auth && "bearer" in remote.auth) h.set("Authorization", `Bearer ${remote.auth.bearer}`);
  else if (remote.auth) {
    const { username, password } = remote.auth.basic;
    h.set("Authorization", `Basic ${base64(`${username}:${password}`)}`);
  }
  return h;
}

async function send(remote: GitRemote, path: string, init: RequestInit, type: string): Promise<Bytes> {
  const url = `${remote.url.replace(/\/+$/, "")}/${path}`;
  const res = await (remote.fetch ?? fetch)(url, init);
  const body = new Uint8Array(await res.arrayBuffer());
  const snippet = () => new TextDecoder().decode(body.subarray(0, 512));
  if (!res.ok) {
    throw new GitHttpError(res.status, `${init.method} ${path}: HTTP ${res.status}`, snippet());
  }
  // gitprotocol-http.txt: clients MUST check the Content-Type of smart responses.
  const ct = res.headers.get("Content-Type");
  if (ct && !ct.startsWith(type)) {
    throw new GitHttpError(res.status, `${path}: expected ${type}, got ${ct}`, snippet());
  }
  return body;
}

/** GET `info/refs?service=…` — the v1 ref advertisement, or the v2 capability advertisement. */
export function advertise(remote: GitRemote, service: GitService, v2: boolean): Promise<Bytes> {
  const extra: Record<string, string> = v2 ? { "Git-Protocol": "version=2" } : {};
  return send(
    remote,
    `info/refs?service=${service}`,
    { method: "GET", headers: headers(remote, extra) },
    `application/x-${service}-advertisement`,
  );
}

/** POST a stateless RPC request to `/<service>`. */
export function rpc(remote: GitRemote, service: GitService, body: Uint8Array, v2: boolean): Promise<Bytes> {
  const extra: Record<string, string> = {
    "Content-Type": `application/x-${service}-request`,
    Accept: `application/x-${service}-result`,
  };
  if (v2) extra["Git-Protocol"] = "version=2";
  return send(
    remote,
    service,
    { method: "POST", headers: headers(remote, extra), body: own(body) },
    `application/x-${service}-result`,
  );
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

/**
 * Advertisement payloads, minus the "# service=<name>" line + flush that smart HTTP prepends
 * (gitprotocol-http.txt "Smart Clients"), up to the closing flush.
 */
function advertisedLines(buf: Uint8Array): Bytes[] {
  const out: Bytes[] = [];
  let index = 0;
  let header = false;
  for (const line of readPktLines(buf)) {
    index++;
    if (line.type === "flush") {
      if (header && index === 2) continue;
      break;
    }
    if (line.type !== "data") continue;
    if (index === 1 && pktText(line.data).startsWith("# service=")) header = true;
    else {
      throwIfErr(line.data);
      out.push(line.data);
    }
  }
  return out;
}

/** gitprotocol-pack.txt "Reference Discovery": `<sha> <ref>[\0<caps>]` lines. */
function parseV1(lines: Bytes[], out: RefMap): void {
  for (const [i, raw] of lines.entries()) {
    let line = pktText(raw);
    if (i === 0) {
      const nul = line.indexOf("\0");
      if (nul >= 0) {
        for (const cap of line.slice(nul + 1).split(" ").filter(Boolean)) {
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
  const adv = advertisedLines(await advertise(remote, service, wantV2));
  let refs: RefMap;
  if (wantV2 && adv[0] && pktText(adv[0]) === "version 2") {
    refs = refMap(2);
    for (const cap of adv.slice(1)) refs.capabilities.add(pktText(cap));
    const args = ["peel\n", "symrefs\n", ...(opts.prefixes ?? []).map((p) => `ref-prefix ${p}\n`)];
    const body = encodeLines(["command=ls-refs\n", `agent=${AGENT}\n`, DELIM, ...args, FLUSH]);
    // gitprotocol-v2.txt "ls-refs": `<oid> <ref>[ symref-target:<t>][ peeled:<oid>]`.
    for (const raw of payloadsUntilFlush(await rpc(remote, "git-upload-pack", body, true))) {
      const [sha, ref, ...attrs] = pktText(raw).split(" ");
      if (!sha || !ref || !isSha(sha)) throw new GitProtocolError(`bad ls-refs line: ${pktText(raw)}`);
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
