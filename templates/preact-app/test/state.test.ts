import { describe, expect, it } from "vitest";
import { createCounter, createServerClock } from "../src/client/state.js";

describe("createCounter", () => {
  it("increments and derives double", () => {
    const c = createCounter(1);
    c.increment();
    expect(c.count.value).toBe(2);
    expect(c.double.value).toBe(4);
  });

  it("resets to the initial value", () => {
    const c = createCounter(3);
    c.increment();
    c.reset();
    expect(c.count.value).toBe(3);
  });
});

describe("createServerClock", () => {
  it("stores the server time", async () => {
    const clock = createServerClock(async () => ({ now: "2026-01-01T00:00:00.000Z" }));
    await clock.refresh();
    expect(clock.now.value).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.error.value).toBeNull();
  });

  it("records an error instead of throwing", async () => {
    const clock = createServerClock(async () => ({ nope: true }));
    await clock.refresh();
    expect(clock.now.value).toBeNull();
    expect(clock.error.value).toBe("unexpected response from /api/time");
  });
});
