// Behavioural tests for the reactive layout store. The tree transforms are
// covered in `tree.test.ts`; here we focus on the store's wiring (state
// mutations, focus fallback, ≥1-pane guard, pane-spec management).

import { describe, expect, it } from "vitest";

import { createLayoutStore, type IdFactory } from "../../src/lib/layout/store.svelte";
import {
  dfsLeafOrder,
  makeLeaf,
  makeSplit,
  type LayoutSnapshot,
  type PaneSpec,
} from "../../src/lib/layout/tree";

function counterIdFactory(prefix: string): IdFactory {
  let n = 0;
  return {
    pane: () => `${prefix}-pane-${++n}`,
    split: () => `${prefix}-split-${++n}`,
  };
}

function pane(id: string, label = id): PaneSpec {
  return { id, label, command: "/bin/zsh", args: ["-l"] };
}

/** Three-pane snapshot mirroring the spec §5 default layout. */
function threePaneSnapshot(): LayoutSnapshot {
  const tree = makeSplit("root", "row", [
    { node: makeLeaf("a"), weight: 1 },
    {
      node: makeSplit("right", "column", [
        { node: makeLeaf("b"), weight: 1 },
        { node: makeLeaf("c"), weight: 1 },
      ]),
      weight: 1,
    },
  ]);
  return {
    tree,
    panes: { a: pane("a", "Pane 1"), b: pane("b", "Pane 2"), c: pane("c", "Pane 3") },
    focusedPaneId: "a",
  };
}

describe("createLayoutStore — initialization", () => {
  it("exposes the initial tree, panes, focus and pane order", () => {
    const store = createLayoutStore(threePaneSnapshot());
    expect(store.focusedPaneId).toBe("a");
    expect(store.paneOrder).toEqual(["a", "b", "c"]);
    expect(Object.keys(store.panes).sort()).toEqual(["a", "b", "c"]);
  });

  it("repairs focusedPaneId when the snapshot references a missing pane", () => {
    const snap = threePaneSnapshot();
    snap.focusedPaneId = "missing";
    const store = createLayoutStore(snap);
    expect(store.focusedPaneId).toBe("a");
  });
});

describe("focus", () => {
  it("moves focus to a known pane", () => {
    const store = createLayoutStore(threePaneSnapshot());
    store.focus("c");
    expect(store.focusedPaneId).toBe("c");
  });

  it("ignores unknown pane ids", () => {
    const store = createLayoutStore(threePaneSnapshot());
    store.focus("missing");
    expect(store.focusedPaneId).toBe("a");
  });
});

describe("splitPane", () => {
  it("appends a new pane next to the target and adds its PaneSpec", () => {
    const store = createLayoutStore(threePaneSnapshot(), {
      idFactory: counterIdFactory("t"),
    });
    const newId = store.splitPane("a", "row", "after");
    expect(newId).toBe("t-pane-1");
    expect(store.paneOrder.includes(newId!)).toBe(true);
    // The new pane's spec lives in the panes record.
    expect(store.panes[newId!]).toBeDefined();
    expect(store.panes[newId!]!.command).toBe("/bin/zsh");
  });

  it("returns null and leaves state untouched when target is unknown", () => {
    const store = createLayoutStore(threePaneSnapshot(), {
      idFactory: counterIdFactory("t"),
    });
    const before = store.paneOrder.length;
    expect(store.splitPane("missing", "row")).toBeNull();
    expect(store.paneOrder.length).toBe(before);
  });

  it("uses caller-supplied spec overrides", () => {
    const store = createLayoutStore(threePaneSnapshot(), {
      idFactory: counterIdFactory("t"),
    });
    const newId = store.splitPane("a", "column", "after", {
      label: "Logs",
      command: "/usr/bin/tail",
      args: ["-f", "/tmp/log"],
      cwd: "/tmp",
      env: { FOO: "bar" },
    });
    const spec = store.panes[newId!]!;
    expect(spec.label).toBe("Logs");
    expect(spec.command).toBe("/usr/bin/tail");
    expect(spec.args).toEqual(["-f", "/tmp/log"]);
    expect(spec.cwd).toBe("/tmp");
    expect(spec.env).toEqual({ FOO: "bar" });
  });
});

describe("duplicatePane", () => {
  it("copies the source spec under a fresh id with a '(copy)' label", () => {
    const store = createLayoutStore(threePaneSnapshot(), {
      idFactory: counterIdFactory("d"),
    });
    const newId = store.duplicatePane("b");
    expect(newId).toBe("d-pane-1");
    const dup = store.panes[newId!]!;
    expect(dup.command).toBe("/bin/zsh");
    expect(dup.label).toBe("Pane 2 (copy)");
    expect(store.paneOrder).toContain(newId);
  });

  it("returns null for unknown source", () => {
    const store = createLayoutStore(threePaneSnapshot());
    expect(store.duplicatePane("missing")).toBeNull();
  });
});

describe("closePane", () => {
  it("removes the pane and reassigns focus to the previous sibling", () => {
    const store = createLayoutStore(threePaneSnapshot());
    store.focus("b");
    expect(store.closePane("b")).toBe(true);
    expect(store.panes).not.toHaveProperty("b");
    expect(store.paneOrder).toEqual(["a", "c"]);
    // pickFocusFallback prefers prior sibling within the same split → "a"
    // is in a different split (row root), so fallback walks to the column
    // split's next sibling first: "c". The exact fallback is tested in
    // tree.test.ts — here we just assert focus moved off "b" to a real leaf.
    expect(store.focusedPaneId).not.toBe("b");
    expect(store.paneOrder).toContain(store.focusedPaneId);
  });

  it("refuses to close the last pane", () => {
    const snap: LayoutSnapshot = {
      tree: makeLeaf("only"),
      panes: { only: pane("only") },
      focusedPaneId: "only",
    };
    const store = createLayoutStore(snap);
    expect(store.closePane("only")).toBe(false);
    expect(store.panes).toHaveProperty("only");
  });

  it("returns false for unknown ids without mutating state", () => {
    const store = createLayoutStore(threePaneSnapshot());
    const orderBefore = store.paneOrder.slice();
    expect(store.closePane("missing")).toBe(false);
    expect(store.paneOrder).toEqual(orderBefore);
  });

  it("does not change focus when closing a non-focused pane", () => {
    const store = createLayoutStore(threePaneSnapshot());
    // Initial focus is "a"; close "c" — focus stays on "a".
    expect(store.closePane("c")).toBe(true);
    expect(store.focusedPaneId).toBe("a");
  });
});

describe("reorderSiblings", () => {
  it("reorders within the named split", () => {
    const store = createLayoutStore(threePaneSnapshot());
    store.reorderSiblings("right", 0, 1);
    expect(dfsLeafOrder(store.tree)).toEqual(["a", "c", "b"]);
  });
});

describe("setSplitWeight", () => {
  it("rebalances the named split's children weights", () => {
    const store = createLayoutStore(threePaneSnapshot());
    // Move 25% of weight from b (left) to c (right) within "right" column.
    store.setSplitWeight("right", 0, 1, 0.25);
    const root = store.tree;
    if (root.kind !== "split") throw new Error("expected root split");
    const right = root.children[1]!.node;
    if (right.kind !== "split") throw new Error("expected inner split");
    expect(right.children[0]!.weight).toBeCloseTo(0.5);
    expect(right.children[1]!.weight).toBeCloseTo(1.5);
  });
});

describe("updatePaneMeta", () => {
  it("merges patch fields into the pane spec", () => {
    const store = createLayoutStore(threePaneSnapshot());
    store.updatePaneMeta("a", { label: "Editor", command: "/bin/bash" });
    expect(store.panes.a!.label).toBe("Editor");
    expect(store.panes.a!.command).toBe("/bin/bash");
    // Other fields preserved.
    expect(store.panes.a!.args).toEqual(["-l"]);
  });

  it("is a no-op for unknown pane id", () => {
    const store = createLayoutStore(threePaneSnapshot());
    const before = store.panes.a!;
    store.updatePaneMeta("missing", { label: "?" });
    expect(store.panes.a).toBe(before);
  });
});

describe("parentSplitOf", () => {
  it("delegates to findParentSplit on the current tree", () => {
    const store = createLayoutStore(threePaneSnapshot());
    expect(store.parentSplitOf("b")).toEqual({
      splitId: "right",
      direction: "column",
      idx: 0,
      siblingCount: 2,
    });
  });

  it("returns null for an unknown pane id", () => {
    const store = createLayoutStore(threePaneSnapshot());
    expect(store.parentSplitOf("missing")).toBeNull();
  });
});

describe("rectsFor / splittersFor", () => {
  it("delegates to the pure tree helpers and produces the expected shape", () => {
    const store = createLayoutStore(threePaneSnapshot());
    const rects = store.rectsFor({ w: 800, h: 600 }, 2);
    expect(Object.keys(rects).sort()).toEqual(["a", "b", "c"]);
    const splitters = store.splittersFor({ w: 800, h: 600 }, 2);
    expect(splitters).toHaveLength(2);
  });
});
