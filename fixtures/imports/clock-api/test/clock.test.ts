import { describe, expect, it } from "vitest";
import { formatOffset, nowAt } from "../src/clock.js";
import worker from "../src/index.js";

describe("formatOffset", () => {
  it("formats UTC as Z", () => {
    expect(formatOffset(0)).toBe("Z");
  });

  it("formats whole and half-hour offsets east of UTC", () => {
    expect(formatOffset(60)).toBe("+01:00");
    expect(formatOffset(330)).toBe("+05:30");
  });

  it("formats offsets west of UTC", () => {
    expect(formatOffset(-300)).toBe("-05:00");
    // Newfoundland: three and a half hours behind UTC.
    expect(formatOffset(-210)).toBe("-03:30");
  });

  it("rejects offsets beyond ±14:00", () => {
    expect(() => formatOffset(15 * 60)).toThrow(RangeError);
  });
});

describe("nowAt", () => {
  it("shifts the wall clock and appends the offset", () => {
    const at = new Date("2026-10-01T12:00:00.000Z");
    expect(nowAt(330, at)).toBe("2026-10-01T17:30:00+05:30");
    expect(nowAt(0, at)).toBe("2026-10-01T12:00:00Z");
  });
});

describe("GET /", () => {
  it("returns the current time at the requested offset", async () => {
    const res = await worker.fetch(new Request("https://example.test/?offset=60"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { now: string };
    expect(body.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+01:00$/);
  });

  it("rejects a bad offset", async () => {
    const res = await worker.fetch(new Request("https://example.test/?offset=9999"));
    expect(res.status).toBe(400);
  });
});
