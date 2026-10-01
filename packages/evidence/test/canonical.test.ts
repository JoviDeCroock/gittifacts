import { describe, expect, it } from "vitest";
import {
  CanonicalizationError,
  canonicalBytes,
  canonicalize,
  stableStringify,
} from "../src/canonical.js";

describe("canonicalize (RFC 8785)", () => {
  it("sorts keys by UTF-16 code units (RFC 8785 §3.2.3 example)", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      דּ: "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      ö: "Latin Small Letter O With Diaeresis",
    };
    const out = canonicalize(input);
    const keys = Object.keys(JSON.parse(out) as Record<string, string>);
    // JSON.parse would reorder integer-like keys, so check the text order instead.
    const order = ["\r", "1", "\u0080", "ö", "€", "😀", "דּ"].map((k) =>
      out.indexOf(JSON.stringify(k)),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(keys).toHaveLength(7);
    // The emoji (U+1F600, surrogates D83D DE00) sorts BEFORE U+FB33 by code units,
    // even though its code point is larger.
    expect(out.indexOf("😀")).toBeLessThan(out.indexOf("דּ"));
  });

  it("matches the RFC 8785 §3.2.2 sample output", () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals":[null,true,false]}',
    ) as unknown;
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it.each([
    [0, "0"],
    [-0, "0"],
    [1, "1"],
    [-1.5, "-1.5"],
    [1e21, "1e+21"],
    [1e20, "100000000000000000000"],
    [999999999999999700000, "999999999999999700000"],
    [0.000001, "0.000001"],
    [1e-7, "1e-7"],
    [5e-324, "5e-324"],
    [-5e-324, "-5e-324"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
    [9007199254740992, "9007199254740992"],
    [0.1 + 0.2, "0.30000000000000004"],
  ])("serializes number %s as %s", (n, expected) => {
    expect(canonicalize(n)).toBe(expected);
    expect(canonicalize([n])).toBe(`[${expected}]`);
  });

  it("serializes nested structures without whitespace", () => {
    expect(canonicalize({ b: [1, { d: true, c: null }], a: { z: "x", y: [] }, e: {} })).toBe(
      '{"a":{"y":[],"z":"x"},"b":[1,{"c":null,"d":true}],"e":{}}',
    );
  });

  it("escapes control characters the JCS way", () => {
    expect(canonicalize("\u0000\u0008\t\n\u000b\f\r\u001f\u007f ")).toBe(
      '"\\u0000\\b\\t\\n\\u000b\\f\\r\\u001f\u007f "',
    );
  });

  it("drops undefined object members but rejects undefined elsewhere", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalize([1, undefined])).toThrow(CanonicalizationError);
    expect(() => canonicalize(undefined)).toThrow(CanonicalizationError);
  });

  it.each([
    ["NaN", { a: Number.NaN }],
    ["Infinity", { a: [Number.POSITIVE_INFINITY] }],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["function", { a: () => 1 }],
    ["symbol", { a: Symbol("x") }],
    ["bigint", { a: 1n }],
    ["Map", { a: new Map() }],
    ["Set", new Set([1])],
    ["Uint8Array", { a: new Uint8Array(2) }],
    ["lone high surrogate", { a: "x\ud800" }],
    ["lone low surrogate key", { "\udc00": 1 }],
  ])("rejects %s", (_name, value) => {
    expect(() => canonicalize(value)).toThrow(CanonicalizationError);
  });

  it("reports where the bad value is", () => {
    try {
      canonicalize({ items: [{ ok: 1 }, { "a/b": Number.NaN }] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CanonicalizationError);
      expect((e as CanonicalizationError).path).toBe("/items/1/a~1b");
    }
  });

  it("rejects cycles but allows shared references", () => {
    const shared = { x: 1 };
    expect(canonicalize({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => canonicalize(cyc)).toThrow(/cyclic/);
  });

  it("uses toJSON like JSON.stringify (Date)", () => {
    const d = new Date("2026-10-01T12:00:00.000Z");
    expect(canonicalize({ at: d })).toBe('{"at":"2026-10-01T12:00:00.000Z"}');
  });

  it("is invariant under key insertion order and JSON round-trip", () => {
    const a = { z: 1, a: { c: [3, 2, 1], b: "é" }, m: null };
    const b = { m: null, a: { b: "é", c: [3, 2, 1] }, z: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(JSON.parse(JSON.stringify(a)))).toBe(canonicalize(a));
  });

  it("canonicalBytes is UTF-8 of the canonical text", () => {
    const bytes = canonicalBytes({ "€": "😀" });
    expect(new TextDecoder().decode(bytes)).toBe('{"€":"😀"}');
    expect(bytes.length).toBe(2 + 3 + 3 + 4 + 2);
  });

  it("does not treat __proto__ specially", () => {
    const o = JSON.parse('{"__proto__":{"x":1},"a":2}') as unknown;
    expect(canonicalize(o)).toBe('{"__proto__":{"x":1},"a":2}');
  });
});

describe("stableStringify", () => {
  it("pretty prints with sorted keys and matches JSON.stringify layout", () => {
    const v = { b: [1, { y: [], x: {} }], a: "s" };
    expect(stableStringify(v)).toBe(JSON.stringify({ a: "s", b: [1, { x: {}, y: [] }] }, null, 2));
    expect(JSON.parse(stableStringify(v))).toEqual(v);
  });

  it("is as strict as canonicalize", () => {
    expect(() => stableStringify({ a: Number.NaN })).toThrow(CanonicalizationError);
  });
});
