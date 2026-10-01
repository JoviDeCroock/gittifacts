import { slugify } from "@queue/text/slug";
import { titleCase } from "@queue/text/title";
import { describe, expect, it } from "vitest";

// Uses both text modules: a test target shared by changes to either.
describe("headline", () => {
  it("titles and slugs a headline", () => {
    const headline = titleCase("merge queues for agents");
    expect(headline).toBe("Merge Queues For Agents");
    expect(slugify(headline)).toBe("merge-queues-for-agents");
  });
});
