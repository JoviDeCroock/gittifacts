import { describe, expect, it } from "vitest";
import {
  DELIM,
  FLUSH,
  GitProtocolError,
  MAX_PKT_LEN,
  RESPONSE_END,
  RemoteError,
  demuxSideband,
  parseReport,
  pktLine,
  pktText,
  readPktLines,
} from "../src/index.js";
import { concat, text, utf8 } from "../src/bytes.js";

const ascii = (b: Uint8Array) => Buffer.from(b).toString("latin1");

describe("pkt-line", () => {
  it("frames lines like the examples in gitprotocol-common", () => {
    expect(ascii(pktLine("a\n"))).toBe("0006a\n");
    expect(ascii(pktLine("a"))).toBe("0005a");
    expect(ascii(pktLine("foobar\n"))).toBe("000bfoobar\n");
    expect(ascii(pktLine(""))).toBe("0004");
    expect(ascii(FLUSH)).toBe("0000");
    expect(ascii(DELIM)).toBe("0001");
    expect(ascii(RESPONSE_END)).toBe("0002");
  });

  it("round-trips data, binary payloads and special packets", () => {
    const binary = new Uint8Array(1000).map((_, i) => i % 256);
    const buf = concat([pktLine("hello\n"), DELIM, pktLine(binary), FLUSH, pktLine(""), RESPONSE_END]);
    const lines = [...readPktLines(buf)];
    expect(lines.map((l) => l.type)).toEqual(["data", "delim", "data", "flush", "data", "response-end"]);
    const [first, , second, , empty] = lines;
    expect(first?.type === "data" && pktText(first.data)).toBe("hello");
    expect(second?.type === "data" && Array.from(second.data)).toEqual(Array.from(binary));
    expect(empty?.type === "data" && empty.data.length).toBe(0);
  });

  it("enforces the 65520-byte maximum", () => {
    expect(pktLine(new Uint8Array(MAX_PKT_LEN - 4)).length).toBe(MAX_PKT_LEN);
    expect(() => pktLine(new Uint8Array(MAX_PKT_LEN - 3))).toThrow(RangeError);
  });

  it("rejects malformed input", () => {
    expect(() => [...readPktLines(utf8("00"))]).toThrow(GitProtocolError);
    expect(() => [...readPktLines(utf8("zzzz"))]).toThrow(/invalid pkt-line length/);
    expect(() => [...readPktLines(utf8("0003"))]).toThrow(/invalid pkt-line length 3/);
    expect(() => [...readPktLines(utf8("0009abc"))]).toThrow(/truncated pkt-line payload/);
  });
});

describe("side-band-64k", () => {
  const band = (n: number, s: string | Uint8Array) =>
    concat([new Uint8Array([n]), typeof s === "string" ? utf8(s) : s]);

  it("joins channel 1 and collects channel 2 progress", () => {
    const { data, progress } = demuxSideband([band(1, "PACK"), band(2, "Counting\r"), band(1, "rest"), band(2, "done\n")]);
    expect(text(data)).toBe("PACKrest");
    expect(progress).toBe("Counting\rdone\n");
  });

  it("throws RemoteError on channel 3 and GitProtocolError on unknown channels", () => {
    expect(() => demuxSideband([band(1, "x"), band(3, "fatal: boom\n")])).toThrow(RemoteError);
    expect(() => demuxSideband([band(3, "fatal: boom\n")])).toThrow("fatal: boom");
    expect(() => demuxSideband([band(4, "?")])).toThrow(GitProtocolError);
  });
});

describe("report-status parsing", () => {
  const report = concat([
    pktLine("unpack ok\n"),
    pktLine("ok refs/heads/main\n"),
    pktLine("ng refs/heads/dev stale ref\n"),
    pktLine("ng refs/notes/x failed to update ref\n"),
    FLUSH,
  ]);
  const expected = {
    unpackOk: true,
    progress: "",
    refs: [
      { ref: "refs/heads/main", ok: true },
      { ref: "refs/heads/dev", ok: false, reason: "stale ref" },
      { ref: "refs/notes/x", ok: false, reason: "failed to update ref" },
    ],
  };

  it("parses a plain report", () => {
    expect(parseReport(report)).toEqual(expected);
  });

  it("parses a report nested inside side-band-64k channel 1", () => {
    const wrapped = concat([
      pktLine(concat([new Uint8Array([2]), utf8("hook says hi\n")])),
      pktLine(concat([new Uint8Array([1]), report.subarray(0, 10)])),
      pktLine(concat([new Uint8Array([1]), report.subarray(10)])),
      FLUSH,
    ]);
    expect(parseReport(wrapped)).toEqual({ ...expected, progress: "hook says hi\n" });
  });

  it("surfaces unpack failures", () => {
    const failed = concat([pktLine("unpack reachable object is missing\n"), pktLine("ng refs/heads/main missing object\n"), FLUSH]);
    expect(parseReport(failed)).toMatchObject({ unpackOk: false, unpackError: "reachable object is missing" });
  });

  it("rejects responses without an unpack line", () => {
    expect(() => parseReport(concat([pktLine("ok refs/heads/main\n"), FLUSH]))).toThrow(GitProtocolError);
    expect(() => parseReport(concat([pktLine("ERR access denied\n")]))).toThrow(RemoteError);
  });
});
