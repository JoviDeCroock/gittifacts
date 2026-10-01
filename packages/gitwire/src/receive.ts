/**
 * Pushing with receive-pack (protocol v1 — the only version Artifacts accepts for push).
 * See git Documentation/gitprotocol-pack.txt "Pushing Data To a Server" and "Report Status",
 * and gitprotocol-capabilities.txt "report-status" / "side-band-64k" / "atomic".
 */
import { type Bytes, ZERO_SHA, assertSha, own } from "./bytes.js";
import { GitProtocolError, MissingObjectError, RejectedError, StaleRefError } from "./errors.js";
import { AGENT, type GitRemote, listRefs, rpc } from "./http.js";
import { buildPack } from "./pack.js";
import { FLUSH, demuxSideband, encodeLines, payloadsUntilFlush, pktText, readPktLines } from "./pktline.js";
import { fetchPack } from "./upload.js";

export interface RefUpdate {
  ref: string;
  /** Expected current value; ZERO_SHA = the ref must not exist yet (create). */
  oldSha: string;
  /** New value; ZERO_SHA = delete. */
  newSha: string;
}

export interface RefResult {
  ref: string;
  ok: boolean;
  reason?: string;
}

export interface PushReport {
  unpackOk: boolean;
  unpackError?: string;
  refs: RefResult[];
  /** Sideband channel 2 text (hook output, etc.). */
  progress: string;
}

export interface ReceivePackOptions {
  /** Request all-or-nothing updates (`atomic` capability; the server must advertise it). */
  atomic?: boolean;
}

/**
 * Sends ref update commands (+ pack) and returns the server's report-status.
 *
 * When no pack is given an empty pack is sent, except for delete-only pushes, where the
 * protocol forbids sending one ("The pack-file MUST NOT be sent if the only command used is
 * 'delete'"). Every command carries its old SHA, so each update is a compare-and-swap.
 */
export async function receivePack(
  remote: GitRemote,
  updates: RefUpdate[],
  pack?: Uint8Array,
  opts: ReceivePackOptions = {},
): Promise<PushReport> {
  if (!updates.length) throw new TypeError("receivePack needs at least one update");
  for (const u of updates) {
    assertSha(u.oldSha, `${u.ref} oldSha`);
    assertSha(u.newSha, `${u.ref} newSha`);
    if (!/^refs\/[^\s\0~^:?*[\\]+$/.test(u.ref) || u.ref.includes("..")) {
      throw new TypeError(`invalid ref name ${u.ref}`);
    }
  }
  const deleteOnly = updates.every((u) => u.newSha === ZERO_SHA);
  if (deleteOnly && pack) throw new TypeError("a pack must not be sent with delete-only updates");
  const caps = ["report-status", "side-band-64k", `agent=${AGENT}`];
  if (opts.atomic) caps.push("atomic");
  // Like git's send-pack: no trailing LF on commands; capabilities ride after NUL on the first.
  const commands = updates.map(
    (u, i) => `${u.oldSha} ${u.newSha} ${u.ref}${i === 0 ? `\0${caps.join(" ")}` : ""}`,
  );
  const tail: Bytes[] = deleteOnly ? [] : [pack ? own(pack) : await buildPack([])];
  const body = encodeLines([...commands, FLUSH, ...tail]);
  return parseReport(await rpc(remote, "git-receive-pack", body, false));
}

/**
 * report-status, possibly wrapped in side-band-64k. With sideband, channel 1 carries the
 * report as nested pkt-lines; without it (a server ignoring the capability) the report is
 * plain. Report lines start with "unpack"/"ok"/"ng", never with the bytes 1-3, so the first
 * payload tells the two apart.
 */
export function parseReport(res: Uint8Array): PushReport {
  let payloads = payloadsUntilFlush(res);
  let progress = "";
  const band = payloads[0]?.[0];
  if (band !== undefined && band >= 1 && band <= 3) {
    const demuxed = demuxSideband(payloads);
    progress = demuxed.progress;
    payloads = [];
    for (const line of readPktLines(demuxed.data)) {
      if (line.type === "flush") break;
      if (line.type === "data") payloads.push(line.data);
    }
  }
  const [first, ...rest] = payloads.map(pktText);
  if (!first?.startsWith("unpack ")) {
    throw new GitProtocolError(`missing unpack status in push response${progress ? `: ${progress.trim()}` : ""}`);
  }
  const unpack = first.slice(7);
  const report: PushReport = { unpackOk: unpack === "ok", refs: [], progress };
  if (unpack !== "ok") report.unpackError = unpack;
  for (const line of rest) {
    if (line.startsWith("ok ")) report.refs.push({ ref: line.slice(3), ok: true });
    else if (line.startsWith("ng ")) {
      const sp = line.indexOf(" ", 3);
      report.refs.push(
        sp < 0
          ? { ref: line.slice(3), ok: false, reason: "" }
          : { ref: line.slice(3, sp), ok: false, reason: line.slice(sp + 1) },
      );
    }
  }
  return report;
}

/**
 * Returns the ref's result if it was updated, else throws a typed error. Reasons differ by
 * server (Artifacts: "stale ref", git: "failed to update ref" / "cannot lock ref"), so the
 * classification is by keyword.
 */
export function assertRefUpdated(report: PushReport, ref: string): RefResult {
  if (!report.unpackOk) {
    const reason = `unpack ${report.unpackError ?? "failed"}`;
    if (/missing/i.test(reason)) throw new MissingObjectError(ref, reason);
    throw new RejectedError(ref, reason);
  }
  const result = report.refs.find((r) => r.ref === ref);
  if (!result) throw new GitProtocolError(`no status reported for ${ref}`);
  if (result.ok) return result;
  const reason = result.reason ?? "";
  if (/missing|bad pack/i.test(reason)) throw new MissingObjectError(ref, reason);
  if (/stale|lock|expected|fetch first|failed to (update|delete)/i.test(reason)) {
    throw new StaleRefError(ref, reason);
  }
  throw new RejectedError(ref, reason);
}

/**
 * Compare-and-swap `ref` from `oldSha` to `newSha` without sending objects (they must already
 * be in the repo). Does not check ancestry: the caller decides that `newSha` is a fast-forward.
 * Throws StaleRefError / MissingObjectError / RejectedError.
 */
export async function fastForward(
  remote: GitRemote,
  ref: string,
  oldSha: string,
  newSha: string,
): Promise<RefResult> {
  return assertRefUpdated(await receivePack(remote, [{ ref, oldSha, newSha }]), ref);
}

export interface TransferOptions {
  /** Commit (or any object) to copy. */
  sha: string;
  /** Ref to point at it in the target, e.g. refs/merge-queue/<changeId>. */
  toRef: string;
  /** Objects the target is known to have. Default: every tip the target advertises. */
  haves?: string[];
}

/**
 * Copies `sha` and everything it reaches (minus what the target has) from one repo to another
 * and points `toRef` at it with CAS against the target's current value. The fetched pack is
 * forwarded unparsed; OFS_DELTA is only requested if the target's receive-pack accepts it.
 */
export async function transferObjects(
  from: GitRemote,
  to: GitRemote,
  opts: TransferOptions,
): Promise<RefResult> {
  assertSha(opts.sha, "sha");
  const target = await listRefs(to, { service: "git-receive-pack" });
  const oldSha = target.get(opts.toRef) ?? ZERO_SHA;
  if (oldSha === opts.sha) return { ref: opts.toRef, ok: true };
  const tips = [...target].filter(([ref]) => !ref.endsWith("^{}")).map(([, sha]) => sha);
  const haves = opts.haves ?? [...new Set(tips)];
  const pack = await fetchPack(from, {
    wants: [opts.sha],
    haves,
    ofsDelta: target.capabilities.has("ofs-delta"),
  });
  const report = await receivePack(to, [{ ref: opts.toRef, oldSha, newSha: opts.sha }], pack);
  return assertRefUpdated(report, opts.toRef);
}
