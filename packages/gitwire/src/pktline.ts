/**
 * pkt-line framing and sideband demultiplexing.
 * See git Documentation/gitprotocol-common.txt "pkt-line Format" and
 * gitprotocol-v2.txt "Packet-Line Framing" (flush 0000, delim 0001, response-end 0002).
 */
import { type Bytes, concat, text, utf8 } from "./bytes.js";
import { GitProtocolError, RemoteError } from "./errors.js";

export type PktLine =
  | { type: "data"; data: Bytes }
  | { type: "flush" }
  | { type: "delim" }
  | { type: "response-end" };

export const FLUSH: Bytes = utf8("0000");
export const DELIM: Bytes = utf8("0001");
export const RESPONSE_END: Bytes = utf8("0002");

/** 65520 bytes including the 4-byte length header (gitprotocol-common "pkt-line Format"). */
export const MAX_PKT_LEN = 65520;

/**
 * Frames one pkt-line. Text lines should carry their own trailing "\n" where the protocol
 * expects one (receivers must accept it either way).
 */
export function pktLine(data: string | Uint8Array): Bytes {
  const body = typeof data === "string" ? utf8(data) : data;
  const len = body.length + 4;
  if (len > MAX_PKT_LEN) throw new RangeError(`pkt-line too long: ${len} > ${MAX_PKT_LEN}`);
  const out = new Uint8Array(len);
  out.set(utf8(len.toString(16).padStart(4, "0")));
  out.set(body, 4);
  return out;
}

/** Encodes a request: strings/bytes become pkt-lines, FLUSH/DELIM/a pack are passed through. */
export function encodeLines(lines: ReadonlyArray<string | Bytes>): Bytes {
  return concat(lines.map((l) => (typeof l === "string" ? pktLine(l) : l)));
}

export function* readPktLines(buf: Uint8Array): Generator<PktLine> {
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new GitProtocolError("truncated pkt-line length");
    const hex = text(buf.subarray(pos, pos + 4));
    if (!/^[0-9a-f]{4}$/i.test(hex)) {
      throw new GitProtocolError(`invalid pkt-line length ${JSON.stringify(hex)} at ${pos}`);
    }
    const len = Number.parseInt(hex, 16);
    if (len === 0) yield { type: "flush" };
    else if (len === 1) yield { type: "delim" };
    else if (len === 2) yield { type: "response-end" };
    else if (len < 4) throw new GitProtocolError(`invalid pkt-line length ${len}`);
    else {
      if (pos + len > buf.length) throw new GitProtocolError("truncated pkt-line payload");
      yield { type: "data", data: buf.slice(pos + 4, pos + len) };
      pos += len;
      continue;
    }
    pos += 4;
  }
}

/** A text payload without its trailing LF. */
export function pktText(data: Uint8Array): string {
  const s = text(data);
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

/**
 * Splits side-band-64k payloads (first byte = band): 1 = data, 2 = progress, 3 = fatal error.
 * See gitprotocol-pack.txt "Packfile Data" and gitprotocol-capabilities.txt "side-band, side-band-64k".
 */
export function demuxSideband(payloads: Iterable<Uint8Array>): { data: Bytes; progress: string } {
  const data: Uint8Array[] = [];
  let progress = "";
  for (const p of payloads) {
    const band = p[0];
    const rest = p.subarray(1);
    if (band === 1) data.push(rest);
    else if (band === 2) progress += text(rest);
    else if (band === 3) throw new RemoteError(text(rest).trim() || "remote error (sideband 3)");
    else throw new GitProtocolError(`unexpected sideband channel ${band}`);
  }
  return { data: concat(data), progress };
}

/** Data payloads up to (not including) the first flush; throws on an `ERR <msg>` line. */
export function payloadsUntilFlush(lines: Iterable<PktLine>): Bytes[] {
  const out: Bytes[] = [];
  for (const line of lines) {
    if (line.type === "flush") break;
    if (line.type !== "data") continue;
    throwIfErr(line.data);
    out.push(line.data);
  }
  return out;
}

/** gitprotocol-pack.txt "Pack Protocol": a server may answer with `ERR <explanation>`. */
export function throwIfErr(data: Uint8Array): void {
  if (text(data.subarray(0, 4)) === "ERR ") throw new RemoteError(pktText(data).slice(4));
}
