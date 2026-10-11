import { describe, expect, it } from "vitest";
import {
  countdown,
  countdownWords,
  durationLabel,
  elapsedFraction,
  shortAge,
  stepTime,
} from "../src/lib/time.js";

const now = Date.parse("2026-10-01T12:00:00Z");
const at = (secondsFromNow: number) => new Date(now + secondsFromNow * 1000).toISOString();

describe("countdown", () => {
  it("shows m:ss under an hour and h:mm:ss above", () => {
    expect(countdown(at(18 * 60 + 42), now)).toBe("18:42");
    expect(countdown(at(3725), now)).toBe("1:02:05");
  });

  it("rounds up so it never shows 0:00 while time remains", () => {
    expect(countdown(at(0.2), now)).toBe("0:01");
  });

  it("stops at 0:00 once the deadline passes", () => {
    expect(countdown(at(-30), now)).toBe("0:00");
    expect(countdown("not a date", now)).toBe("0:00");
  });

  it("has a spoken form with minute precision", () => {
    expect(countdownWords(at(61), now)).toBe("2 minutes left");
    expect(countdownWords(at(60), now)).toBe("1 minute left");
    expect(countdownWords(at(90 * 60), now)).toBe("1 hour 30 min left");
    expect(countdownWords(at(-1), now)).toBe("time is up");
  });
});

describe("shortAge", () => {
  it("compacts ages for lists", () => {
    expect(shortAge(at(-20), now)).toBe("now");
    expect(shortAge(at(-4 * 60), now)).toBe("4m");
    expect(shortAge(at(-3 * 3600), now)).toBe("3h");
    expect(shortAge(at(-2 * 86400), now)).toBe("2d");
    expect(shortAge(at(-21 * 86400), now)).toBe("3w");
  });
});

describe("elapsedFraction", () => {
  it("clamps to the window", () => {
    expect(elapsedFraction(at(-300), at(300), now)).toBe(0.5);
    expect(elapsedFraction(at(60), at(120), now)).toBe(0);
    expect(elapsedFraction(at(-120), at(-60), now)).toBe(1);
  });
});

describe("durationLabel", () => {
  it("picks a readable unit", () => {
    expect(durationLabel(400)).toBe("400 ms");
    expect(durationLabel(6100)).toBe("6.1 s");
    expect(durationLabel(21_800)).toBe("22 s");
    expect(durationLabel(96_000)).toBe("1 min 36 s");
  });
});

describe("stepTime", () => {
  it("shows a passed step's duration, a running step's elapsed time, else its status", () => {
    expect(stepTime({ status: "passed", durationMs: 4200 })).toBe("4.2 s");
    expect(stepTime({ status: "running", durationMs: null, elapsedMs: 95_000 })).toBe(
      "running 1 min 35 s",
    );
    expect(stepTime({ status: "running", durationMs: null })).toBe("running");
    expect(stepTime({ status: "pending", durationMs: null })).toBe("queued");
    expect(stepTime({ status: "failed", durationMs: 10 })).toBe("failed");
  });
});
