import { describe, expect, it } from "vitest";
import {
  EvidenceLineScanner,
  type LogBucket,
  R2LogSink,
  TailBuffer,
} from "../../src/runner/log-sink.js";
import {
  createStreamRedactor,
  REDACTED,
  redactText,
  secretVariants,
} from "../../src/runner/redact.js";
import {
  checkoutEnv,
  isTimeoutExit,
  shellQuote,
  timedCommandArgv,
  workspacePath,
} from "../../src/runner/shell.js";

const TOKEN = "art_v2_e_0123456789abcdef0123456789abcdef01234567?expires=1790000000";

describe("redaction", () => {
  it("removes exact secrets, their encodings and token-shaped strings", () => {
    const text = [
      `token=${TOKEN}`,
      `encoded=${encodeURIComponent(TOKEN)}`,
      "other art_v1_deadbeefdeadbeef?expires=1",
      "Authorization: Bearer abc.def",
      "https://x:supersecret@host/git/repo.git",
    ].join("\n");
    const out = redactText(text, secretVariants(TOKEN));
    expect(out).not.toContain("0123456789abcdef");
    expect(out).not.toContain("deadbeef");
    expect(out).not.toContain("abc.def");
    expect(out).not.toContain("supersecret");
    expect(out).toContain(`Authorization: Bearer ${REDACTED}`);
    expect(out).toContain(`https://x:${REDACTED}@host`);
  });

  it("catches secrets split across chunks", () => {
    const secret = "s3cr3t-value-that-is-long";
    const r = createStreamRedactor([secret]);
    let out = "";
    const input = `line one\nprefix ${secret} suffix\nlast`;
    for (let i = 0; i < input.length; i += 3) out += r.push(input.slice(i, i + 3));
    out += r.flush();
    expect(out).toBe(`line one\nprefix ${REDACTED} suffix\nlast`);
  });

  it("bounds what it holds for lines without newlines", () => {
    const r = createStreamRedactor(["abcdefgh12345"], { maxHold: 100, overlap: 20 });
    const emitted = r.push("x".repeat(150));
    expect(emitted.length).toBe(130);
    expect(r.flush().length).toBe(20);
  });
});

describe("shell", () => {
  it("quotes arbitrary strings for sh", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(() => shellQuote("a\0b")).toThrow();
  });

  it("wraps commands in coreutils timeout", () => {
    expect(timedCommandArgv("pnpm test && echo 'ok'", 600)).toEqual([
      "sh",
      "-c",
      `exec timeout --kill-after=10 600 sh -c 'pnpm test && echo '\\''ok'\\'''`,
    ]);
    expect(() => timedCommandArgv("x", 0)).toThrow();
    expect(isTimeoutExit(124)).toBe(true);
    expect(isTimeoutExit(137)).toBe(true);
    expect(isTimeoutExit(1)).toBe(false);
  });

  it("puts the token only in git config env", () => {
    const env = checkoutEnv({ remote: "https://r", headSha: "h", token: "tok" });
    expect(env.GIT_CONFIG_VALUE_0).toBe("Authorization: Bearer tok");
    expect(env.GITTIFACTS_BASE_SHA).toBeUndefined();
    expect(workspacePath(undefined)).toBe("/workspace");
    expect(workspacePath("apps/web")).toBe("/workspace/apps/web");
  });
});

class FakeBucket {
  objects = new Map<string, Uint8Array>();
  parts: { key: string; n: number; size: number }[] = [];
  completed: string[] = [];
  aborted: string[] = [];
  async put(key: string, value: Uint8Array) {
    this.objects.set(key, value);
    return null;
  }
  async createMultipartUpload(key: string) {
    const chunks: Uint8Array[] = [];
    return {
      key,
      uploadId: "u1",
      uploadPart: async (n: number, value: Uint8Array) => {
        this.parts.push({ key, n, size: value.byteLength });
        chunks[n - 1] = value;
        return { partNumber: n, etag: `e${n}` };
      },
      complete: async () => {
        const total = chunks.reduce((s, c) => s + c.byteLength, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
          out.set(c, o);
          o += c.byteLength;
        }
        this.objects.set(key, out);
        this.completed.push(key);
      },
      abort: async () => {
        this.aborted.push(key);
      },
    };
  }
}

const asBucket = (b: FakeBucket) => b as unknown as LogBucket;
const text = (b: FakeBucket, key: string) => new TextDecoder().decode(b.objects.get(key));

describe("R2LogSink", () => {
  it("writes small logs with a single put", async () => {
    const b = new FakeBucket();
    const sink = new R2LogSink(asBucket(b), "k", { partBytes: 16 });
    await sink.write("hello ");
    await sink.write("world");
    expect(await sink.close()).toEqual({ key: "k", bytes: 11, truncated: false });
    expect(text(b, "k")).toBe("hello world");
    expect(b.parts).toEqual([]);
  });

  it("switches to fixed-size multipart parts for large logs", async () => {
    const b = new FakeBucket();
    const sink = new R2LogSink(asBucket(b), "k", { partBytes: 10 });
    for (let i = 0; i < 5; i++) await sink.write("0123456");
    const res = await sink.close();
    expect(res.bytes).toBe(35);
    expect(b.parts.map((p) => p.size)).toEqual([10, 10, 10, 5]);
    expect(text(b, "k")).toBe("0123456".repeat(5));
  });

  it("truncates at maxBytes and appends a marker", async () => {
    const b = new FakeBucket();
    const sink = new R2LogSink(asBucket(b), "k", { maxBytes: 8, partBytes: 1024 });
    await sink.write("abcdef");
    await sink.write("ghijkl");
    await sink.write("more");
    const res = await sink.close();
    expect(res.truncated).toBe(true);
    expect(text(b, "k")).toMatch(/^abcdefgh\n\[gittifacts: log truncated at 8 bytes\]\n$/);
  });

  it("aborts a multipart upload", async () => {
    const b = new FakeBucket();
    const sink = new R2LogSink(asBucket(b), "k", { partBytes: 2 });
    await sink.write("abcd");
    await sink.abort();
    expect(b.aborted).toEqual(["k"]);
  });
});

describe("TailBuffer and EvidenceLineScanner", () => {
  it("keeps the tail", () => {
    const t = new TailBuffer(5);
    t.push("abc");
    t.push("defg");
    expect(t.toString()).toBe("cdefg");
  });

  it("finds the last ::evidence:: line across chunks", () => {
    const s = new EvidenceLineScanner();
    s.push('noise\n::evidence::{"a"');
    s.push(':1}\n::evidence::{"b":2}\r\ntrailing');
    expect(s.finish()).toBe('{"b":2}');
  });

  it("flags evidence lines that are too long", () => {
    const s = new EvidenceLineScanner(10);
    s.push("::evidence::0123456789abc");
    s.push("def\nok\n");
    expect(s.finish()).toBeNull();
    expect(s.overflowed).toBe(true);
  });
});
