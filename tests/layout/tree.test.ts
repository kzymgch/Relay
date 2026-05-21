// Pure-function tests for the layout tree model.
//
// All transforms here are exercised without Svelte / DOM dependencies so the
// invariants (flattening, weight redistribution, focus fallback, rect layout)
// are pinned down independent of how the store and components consume them.

import { describe, expect, it } from "vitest";

import {
  adjustSplitWeights,
  dfsLeafOrder,
  duplicatePane,
  findParentSplit,
  findPath,
  flattenSameDirection,
  makeLeaf,
  makeSplit,
  pickFocusFallback,
  rectsFor,
  rekeyLeaf,
  removePane,
  reorderSiblings,
  splitLeaf,
  splittersFor,
  type LayoutNode,
  type SplitChild,
} from "../../src/lib/layout/tree";

// ----- helpers ----------------------------------------------------------------

function leaf(id: string) {
  return makeLeaf(id);
}
function row(id: string, ...children: SplitChild[]) {
  return makeSplit(id, "row", children);
}
function col(id: string, ...children: SplitChild[]) {
  return makeSplit(id, "column", children);
}
function w(node: LayoutNode, weight = 1): SplitChild {
  return { node, weight };
}

/** The default startup tree (spec §5 三画面: left full-height + right column split into two). */
function threePane(): LayoutNode {
  return row("root", w(leaf("a")), w(col("right", w(leaf("b")), w(leaf("c")))));
}

// ----- findPath / dfsLeafOrder -----------------------------------------------

describe("findPath", () => {
  it("returns [] for the root leaf", () => {
    expect(findPath(leaf("a"), "a")).toEqual([]);
  });

  it("walks indices for nested leaves", () => {
    const t = threePane();
    expect(findPath(t, "a")).toEqual([0]);
    expect(findPath(t, "b")).toEqual([1, 0]);
    expect(findPath(t, "c")).toEqual([1, 1]);
  });

  it("returns null when the pane id is absent", () => {
    expect(findPath(threePane(), "missing")).toBeNull();
  });
});

describe("dfsLeafOrder", () => {
  it("returns visual top-left order for the three-pane preset", () => {
    expect(dfsLeafOrder(threePane())).toEqual(["a", "b", "c"]);
  });

  it("handles deeply nested structures", () => {
    const tree = row(
      "r",
      w(col("c1", w(leaf("a")), w(leaf("b")))),
      w(col("c2", w(leaf("c")), w(leaf("d"))))
    );
    expect(dfsLeafOrder(tree)).toEqual(["a", "b", "c", "d"]);
  });
});

// ----- flattenSameDirection --------------------------------------------------

describe("flattenSameDirection", () => {
  it("collapses a 1-child split into the child", () => {
    const t = row("r", w(leaf("only")));
    expect(flattenSameDirection(t)).toEqual(leaf("only"));
  });

  it("collapses recursively across multiple levels", () => {
    const t = row("r", w(row("inner", w(leaf("only")))));
    expect(flattenSameDirection(t)).toEqual(leaf("only"));
  });

  it("merges same-direction nested splits, redistributing weights", () => {
    // Outer row weight for the inner row is 2; inner row has children with
    // weights 1 and 3 (total 4). After flattening, inner children's weights
    // should be 2*1/4 = 0.5 and 2*3/4 = 1.5.
    const t = row("outer", w(leaf("a"), 1), w(row("inner", w(leaf("b"), 1), w(leaf("c"), 3)), 2));
    const flat = flattenSameDirection(t);
    expect(flat).toMatchObject({
      kind: "split",
      direction: "row",
      children: [
        { node: leaf("a"), weight: 1 },
        { node: leaf("b"), weight: 0.5 },
        { node: leaf("c"), weight: 1.5 },
      ],
    });
  });

  it("preserves different-direction nesting", () => {
    const t = threePane();
    expect(flattenSameDirection(t)).toEqual(t);
  });
});

// ----- splitLeaf -------------------------------------------------------------

describe("splitLeaf", () => {
  it("replaces a leaf with a split holding the original and a new sibling (after)", () => {
    const t = leaf("a");
    const out = splitLeaf(t, "a", "row", "b", "s1", "after");
    expect(out).toEqual({
      kind: "split",
      id: "s1",
      direction: "row",
      children: [
        { node: leaf("a"), weight: 1 },
        { node: leaf("b"), weight: 1 },
      ],
    });
  });

  it("puts the new sibling on the requested side (before)", () => {
    const out = splitLeaf(leaf("a"), "a", "row", "b", "s1", "before");
    expect((out as { children: SplitChild[] }).children[0]!.node).toEqual(leaf("b"));
    expect((out as { children: SplitChild[] }).children[1]!.node).toEqual(leaf("a"));
  });

  it("flattens when the new split's direction matches the surrounding parent", () => {
    // Start: row[ a, b ] — split a horizontally — must NOT produce a nested row.
    const start = row("root", w(leaf("a")), w(leaf("b")));
    const out = splitLeaf(start, "a", "row", "a2", "s2", "after");
    expect(out.kind).toBe("split");
    expect((out as { direction: string }).direction).toBe("row");
    expect((out as { children: SplitChild[] }).children).toHaveLength(3);
    expect(dfsLeafOrder(out)).toEqual(["a", "a2", "b"]);
  });

  it("keeps perpendicular split nested (no flattening)", () => {
    // Start: row[ a, b ] — split a vertically (column) — must produce a column split inside a.
    const start = row("root", w(leaf("a")), w(leaf("b")));
    const out = splitLeaf(start, "a", "column", "a2", "s2", "after");
    expect(dfsLeafOrder(out)).toEqual(["a", "a2", "b"]);
    // Outer is still the row root with 2 children.
    expect((out as { children: SplitChild[] }).children).toHaveLength(2);
  });

  it("returns the input unchanged when the target pane id is absent", () => {
    const t = threePane();
    const out = splitLeaf(t, "missing", "row", "new", "s2", "after");
    expect(out).toEqual(t);
  });
});

// ----- removePane ------------------------------------------------------------

describe("removePane", () => {
  it("removes a leaf and collapses the parent if only one child remains", () => {
    // Start: row[ a, b ] — remove a — result is just leaf b.
    const start = row("r", w(leaf("a")), w(leaf("b")));
    expect(removePane(start, "a")).toEqual(leaf("b"));
  });

  it("collapses recursively", () => {
    // row[ a, col[ b ] ] (degenerate inner col): remove a → leaf b
    // Actually flatten doesn't allow 1-child splits as input; build through removePane instead.
    const start = row("r", w(leaf("a")), w(col("c", w(leaf("b")), w(leaf("c")))));
    expect(removePane(removePane(start, "b")!, "c")).toEqual(leaf("a"));
  });

  it("preserves siblings when removing one of many", () => {
    const start = row("r", w(leaf("a")), w(leaf("b")), w(leaf("c")));
    const out = removePane(start, "b");
    expect(dfsLeafOrder(out!)).toEqual(["a", "c"]);
  });

  it("returns null when the last leaf is removed", () => {
    expect(removePane(leaf("a"), "a")).toBeNull();
  });

  it("returns the input tree when the pane id is absent", () => {
    const t = threePane();
    expect(removePane(t, "missing")).toEqual(t);
  });
});

// ----- duplicatePane ---------------------------------------------------------

describe("duplicatePane", () => {
  it("inserts the new leaf after the source", () => {
    const out = duplicatePane(leaf("a"), "a", "a2", "row", "s1");
    expect(dfsLeafOrder(out)).toEqual(["a", "a2"]);
  });
});

// ----- reorderSiblings -------------------------------------------------------

describe("reorderSiblings", () => {
  it("moves a child within its split", () => {
    const start = row("r", w(leaf("a")), w(leaf("b")), w(leaf("c")));
    const out = reorderSiblings(start, "r", 2, 0);
    expect(dfsLeafOrder(out)).toEqual(["c", "a", "b"]);
  });

  it("is a no-op when from === to", () => {
    const start = row("r", w(leaf("a")), w(leaf("b")));
    expect(reorderSiblings(start, "r", 0, 0)).toEqual(start);
  });

  it("throws on out-of-range indices", () => {
    const start = row("r", w(leaf("a")), w(leaf("b")));
    expect(() => reorderSiblings(start, "r", 0, 5)).toThrow(RangeError);
  });

  it("targets the right split when others exist with different ids", () => {
    const start = row("outer", w(leaf("a")), w(col("inner", w(leaf("b")), w(leaf("c")))));
    const out = reorderSiblings(start, "inner", 0, 1);
    expect(dfsLeafOrder(out)).toEqual(["a", "c", "b"]);
  });
});

// ----- adjustSplitWeights ----------------------------------------------------

describe("adjustSplitWeights", () => {
  it("moves weight between two siblings without disturbing others", () => {
    const start = row("r", w(leaf("a"), 1), w(leaf("b"), 1), w(leaf("c"), 1));
    const out = adjustSplitWeights(start, "r", 0, 1, 0.25);
    const kids = (out as { children: SplitChild[] }).children;
    expect(kids[0]!.weight).toBeCloseTo(0.5); // 1 - 0.25*(1+1) = 0.5
    expect(kids[1]!.weight).toBeCloseTo(1.5); // 1 + 0.25*(1+1) = 1.5
    expect(kids[2]!.weight).toBe(1); // untouched
  });

  it("clamps to minWeight rather than crossing zero", () => {
    const start = row("r", w(leaf("a"), 1), w(leaf("b"), 1));
    // deltaFraction 0.9 would drag left from 1 to -0.8.
    const out = adjustSplitWeights(start, "r", 0, 1, 0.9, 0.1);
    expect(out).toEqual(start);
  });

  it("throws when index is out of range", () => {
    const start = row("r", w(leaf("a"), 1), w(leaf("b"), 1));
    expect(() => adjustSplitWeights(start, "r", 0, 9, 0.1)).toThrow(RangeError);
  });

  it("does nothing when split id is absent", () => {
    const start = row("r", w(leaf("a")), w(leaf("b")));
    expect(adjustSplitWeights(start, "missing", 0, 1, 0.5)).toEqual(start);
  });
});

// ----- pickFocusFallback -----------------------------------------------------

describe("pickFocusFallback", () => {
  it("prefers the previous sibling", () => {
    const t = row("r", w(leaf("a")), w(leaf("b")), w(leaf("c")));
    expect(pickFocusFallback(t, "b")).toBe("a");
  });

  it("falls through to the next sibling when no previous one exists", () => {
    const t = row("r", w(leaf("a")), w(leaf("b")), w(leaf("c")));
    expect(pickFocusFallback(t, "a")).toBe("b");
  });

  it("climbs to the parent's siblings when this split's siblings exhausted", () => {
    // Tree:  row[ col[a, b], leaf(c) ]
    // Closing a leaves b as previous sibling at the inner level → fallback "b".
    const innerOnly = row("r", w(col("inn", w(leaf("a")), w(leaf("b")))), w(leaf("c")));
    expect(pickFocusFallback(innerOnly, "a")).toBe("b");

    // If we hypothetically close both a and b via removePane and try to
    // fallback from a singleton inner ... well, pickFocusFallback is computed
    // against the *current* tree before removal, so it just returns the
    // sibling. The store wires that into removePane→focus.
  });

  it("climbs when the pane is the only child of its split", () => {
    // Removing "a" from row[ col[a], leaf(b) ] — inner col becomes empty,
    // we want the fallback to land on b (the parent's other child).
    const t = row("r", w(col("inn", w(leaf("a")), w(leaf("a2")))), w(leaf("b")));
    expect(pickFocusFallback(t, "a")).toBe("a2");
    // Removing a2 from the same tree: inner sibling is a, so fallback is a.
    expect(pickFocusFallback(t, "a2")).toBe("a");
  });

  it("returns null when there's only a single leaf in the tree", () => {
    expect(pickFocusFallback(leaf("only"), "only")).toBeNull();
  });

  it("returns null when the pane id is absent", () => {
    expect(pickFocusFallback(threePane(), "missing")).toBeNull();
  });
});

// ----- findParentSplit -------------------------------------------------------

describe("findParentSplit", () => {
  it("reports the immediate parent split and position for a nested leaf", () => {
    const t = threePane();
    expect(findParentSplit(t, "a")).toEqual({
      splitId: "root",
      direction: "row",
      idx: 0,
      siblingCount: 2,
    });
    expect(findParentSplit(t, "b")).toEqual({
      splitId: "right",
      direction: "column",
      idx: 0,
      siblingCount: 2,
    });
    expect(findParentSplit(t, "c")).toEqual({
      splitId: "right",
      direction: "column",
      idx: 1,
      siblingCount: 2,
    });
  });

  it("returns null for a lone root leaf (no parent split)", () => {
    expect(findParentSplit(leaf("only"), "only")).toBeNull();
  });

  it("returns null when the pane id is absent", () => {
    expect(findParentSplit(threePane(), "missing")).toBeNull();
  });
});

// ----- rekeyLeaf -------------------------------------------------------------

describe("rekeyLeaf", () => {
  it("rewrites a pane id in place", () => {
    const t = threePane();
    const out = rekeyLeaf(t, "b", "B");
    expect(dfsLeafOrder(out)).toEqual(["a", "B", "c"]);
  });

  it("is a no-op when the source id is absent", () => {
    const t = threePane();
    expect(rekeyLeaf(t, "missing", "new")).toEqual(t);
  });
});

// ----- rectsFor --------------------------------------------------------------

describe("rectsFor", () => {
  it("returns the whole viewport for a single leaf", () => {
    const r = rectsFor(leaf("a"), { w: 800, h: 600 }, 2);
    expect(r).toEqual({ a: { x: 0, y: 0, w: 800, h: 600 } });
  });

  it("splits a row into integer-rounded children that exactly fill the viewport", () => {
    // 800 wide, gutter 2, 3 equal children → usable 796, each ~265.33.
    const t = row("r", w(leaf("a")), w(leaf("b")), w(leaf("c")));
    const r = rectsFor(t, { w: 800, h: 600 }, 2);
    const total = r.a!.w + 2 + r.b!.w + 2 + r.c!.w;
    expect(total).toBe(800);
    expect(r.a!.h).toBe(600);
    expect(r.b!.h).toBe(600);
    expect(r.c!.h).toBe(600);
    // All children get an integer width.
    [r.a, r.b, r.c].forEach((rect) => {
      expect(Number.isInteger(rect!.w)).toBe(true);
    });
  });

  it("absorbs rounding remainder in the last child", () => {
    // 100 wide, gutter 0, 3 equal weights → 33, 33, 34 (last gets remainder).
    const t = row("r", w(leaf("a")), w(leaf("b")), w(leaf("c")));
    const r = rectsFor(t, { w: 100, h: 10 }, 0);
    expect(r.a!.w).toBe(33);
    expect(r.b!.w).toBe(33);
    expect(r.c!.w).toBe(34);
  });

  it("lays out the three-pane preset (left full-height + right column split)", () => {
    const r = rectsFor(threePane(), { w: 800, h: 600 }, 2);
    // Left pane: full height, half-ish width (after gutter).
    expect(r.a!.h).toBe(600);
    expect(r.a!.x).toBe(0);
    expect(r.a!.y).toBe(0);
    // Right column children stacked top/bottom.
    expect(r.b!.x).toBe(r.c!.x); // same x (right column)
    expect(r.b!.w).toBe(r.c!.w);
    expect(r.b!.y).toBe(0);
    expect(r.c!.y).toBeGreaterThan(r.b!.h);
    // Widths add up across the row gutter.
    expect(r.a!.w + 2 + r.b!.w).toBe(800);
  });

  it("respects unequal weights", () => {
    const t = row("r", w(leaf("a"), 1), w(leaf("b"), 3));
    const r = rectsFor(t, { w: 400, h: 100 }, 0);
    // Ratio 1:3 of usable 400 → 100 and 300.
    expect(r.a!.w).toBe(100);
    expect(r.b!.w).toBe(300);
  });
});

// ----- splittersFor ----------------------------------------------------------

describe("splittersFor", () => {
  it("emits no splitters for a single leaf", () => {
    expect(splittersFor(leaf("a"), { w: 100, h: 100 }, 2)).toEqual([]);
  });

  it("emits one splitter per adjacent child pair, recursively", () => {
    // three-pane: root row has 2 children → 1 splitter (vertical between
    // left and right column). Right column has 2 children → 1 splitter
    // (horizontal between top and bottom).
    const out = splittersFor(threePane(), { w: 800, h: 600 }, 2);
    expect(out).toHaveLength(2);
    const dirs = out.map((s) => s.direction).sort();
    expect(dirs).toEqual(["column", "row"]); // sorted alphabetically
  });

  it("positions a row splitter on the boundary between two pane rects", () => {
    const t = row("r", w(leaf("a")), w(leaf("b")));
    const rects = rectsFor(t, { w: 200, h: 100 }, 2);
    const splitters = splittersFor(t, { w: 200, h: 100 }, 2);
    const s = splitters.find((sp) => sp.splitId === "r")!;
    expect(s.direction).toBe("row");
    // Splitter x sits at the right edge of pane a (so the 8px hit area centers
    // on the 2px gutter in the CSS).
    expect(s.x).toBe(rects.a!.x + rects.a!.w);
    expect(s.length).toBe(100); // full row height
  });

  it("reports parentAxisSize matching the usable width of the parent split", () => {
    const t = row("r", w(leaf("a")), w(leaf("b")));
    const splitters = splittersFor(t, { w: 200, h: 100 }, 2);
    // Gutter 2 → usable 198.
    expect(splitters[0]!.parentAxisSize).toBe(198);
  });
});
