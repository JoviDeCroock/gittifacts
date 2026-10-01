/**
 * Fetching packs with protocol v2 `fetch` (git Documentation/gitprotocol-v2.txt "fetch").
 * One stateless round trip: we send wants + haves + `done`, so the server skips negotiation and
 * replies with optional `shallow-info` and then the `packfile` section, multiplexed on sideband.
 */
import { type Bytes, assertSha } from "./bytes.js";
import { GitProtocolError } from "./errors.js";
import { AGENT, type GitRemote, rpc } from "./http.js";
import { DELIM, FLUSH, demuxSideband, encodeLines, pktText, readPktLines, throwIfErr } from "./pktline.js";

export interface FetchPackOptions {
  wants: string[];
  /** Objects the receiver already has; the server omits everything reachable from them. */
  haves?: string[];
  /** Shallow fetch (`deepen <n>`): 1 = only the wanted commits themselves. */
  depth?: number;
  /** Partial clone filter, e.g. "blob:none" (needs `filter` in the server's fetch capability). */
  filter?: string;
  /** Allow OFS_DELTA entries (default true). Set false when forwarding to a server without `ofs-delta`. */
  ofsDelta?: boolean;
}

/**
 * Returns a complete (never thin) pack containing the wants minus whatever the haves reach.
 * Without `thin-pack`, deltas only reference objects inside the same pack, so the result can be
 * parsed or pushed as-is.
 */
export async function fetchPack(remote: GitRemote, opts: FetchPackOptions): Promise<Bytes> {
  if (!opts.wants.length) throw new TypeError("fetchPack needs at least one want");
  for (const w of opts.wants) assertSha(w, "want");
  for (const h of opts.haves ?? []) assertSha(h, "have");
  const args: string[] = ["no-progress\n"];
  if (opts.ofsDelta !== false) args.push("ofs-delta\n");
  if (opts.depth !== undefined) {
    if (!Number.isInteger(opts.depth) || opts.depth < 1) throw new TypeError("depth must be >= 1");
    args.push(`deepen ${opts.depth}\n`);
  }
  if (opts.filter) args.push(`filter ${opts.filter}\n`);
  for (const w of new Set(opts.wants)) args.push(`want ${w}\n`);
  for (const h of new Set(opts.haves)) args.push(`have ${h}\n`);
  args.push("done\n");
  const body = encodeLines(["command=fetch\n", `agent=${AGENT}\n`, DELIM, ...args, FLUSH]);
  const res = await rpc(remote, "git-upload-pack", body, true);

  // Response: sections separated by delim-pkt, each starting with its name; ends with flush.
  let section: string | undefined;
  const packPayloads: Bytes[] = [];
  for (const line of readPktLines(res)) {
    if (line.type === "flush" || line.type === "response-end") break;
    if (line.type === "delim") {
      section = undefined;
      continue;
    }
    if (section === "packfile") {
      packPayloads.push(line.data);
      continue;
    }
    throwIfErr(line.data);
    // Section header, or a line of shallow-info / acknowledgments / wanted-refs (all ignored).
    if (section === undefined) section = pktText(line.data);
  }
  if (section !== "packfile") throw new GitProtocolError("fetch response has no packfile section");
  return demuxSideband(packPayloads).data;
}
