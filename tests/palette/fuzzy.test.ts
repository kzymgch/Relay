import { describe, expect, it } from "vitest";

import { fuzzyMatch } from "../../src/lib/palette/fuzzy";

describe("fuzzyMatch", () => {
  it("returns null when the query characters aren't a subsequence", () => {
    expect(fuzzyMatch("Save layout", "xyz")).toBeNull();
    expect(fuzzyMatch("Save layout", "savx")).toBeNull();
  });

  it("matches empty query with score 0 (no filter)", () => {
    const m = fuzzyMatch("Anything goes", "");
    expect(m).not.toBeNull();
    expect(m!.score).toBe(0);
    expect(m!.matched).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("Save Layout", "SAVE")).not.toBeNull();
    expect(fuzzyMatch("save layout", "Save")).not.toBeNull();
  });

  it("ranks consecutive runs above scattered hits with the same letters", () => {
    const consecutive = fuzzyMatch("Save layout", "save")!;
    const scattered = fuzzyMatch("Search variable", "sav")!;
    expect(consecutive.score).toBeGreaterThan(scattered.score);
  });

  it("ranks prefix matches above mid-word matches", () => {
    const prefix = fuzzyMatch("Layout: 2x2", "lay")!;
    const mid = fuzzyMatch("Display layout", "lay")!;
    expect(prefix.score).toBeGreaterThan(mid.score);
  });

  it("ranks word-boundary matches above mid-token matches", () => {
    // Both candidates contain the substring "se" but only the first has it
    // at a word boundary ("Save" / "Settings").
    const boundary = fuzzyMatch("Save session", "ss")!;
    const mid = fuzzyMatch("Crosses bases", "ss")!;
    expect(boundary.score).toBeGreaterThan(mid.score);
  });

  it("records the indexes of matched characters for highlight rendering", () => {
    const m = fuzzyMatch("Save layout", "save")!;
    // Lowercase compare matches indexes 0..3 → "Save".
    expect(m.matched).toEqual([0, 1, 2, 3]);
  });
});
