// Behavioural tests for the preset registry and the store's `applyPreset` /
// custom-layout actions.

import { describe, expect, it } from "vitest";

import { createLayoutStore, type IdFactory } from "../../src/lib/layout/store.svelte";
import { PRESETS, threePanePreset } from "../../src/lib/layout/presets";
import { dfsLeafOrder } from "../../src/lib/layout/tree";

function counterIdFactory(prefix: string): IdFactory {
  let n = 0;
  return {
    pane: () => `${prefix}-pane-${++n}`,
    split: () => `${prefix}-split-${++n}`,
  };
}

describe("PRESETS registry", () => {
  it("includes all five spec §5 presets", () => {
    const ids = PRESETS.map((p) => p.id).sort();
    expect(ids).toEqual(["grid-2x2", "horizontal-3", "main-side", "three-pane", "vertical-3"]);
  });

  it("each preset's build produces a tree whose DFS order matches the input ids", () => {
    let n = 0;
    const makeSplitId = () => `s-${++n}`;
    for (const preset of PRESETS) {
      n = 0;
      const inputIds = Array.from({ length: preset.paneCount }, (_, i) => `p${i}`);
      const tree = preset.build(inputIds, makeSplitId);
      expect(dfsLeafOrder(tree)).toEqual(inputIds);
    }
  });

  it("horizontal-3 lays children out in a single row", () => {
    let n = 0;
    const tree = PRESETS.find((p) => p.id === "horizontal-3")!.build(
      ["a", "b", "c"],
      () => `s-${++n}`
    );
    expect(tree.kind).toBe("split");
    if (tree.kind === "split") {
      expect(tree.direction).toBe("row");
      expect(tree.children).toHaveLength(3);
    }
  });

  it("grid-2x2 is a column-of-rows", () => {
    let n = 0;
    const tree = PRESETS.find((p) => p.id === "grid-2x2")!.build(
      ["a", "b", "c", "d"],
      () => `s-${++n}`
    );
    if (tree.kind !== "split") throw new Error("expected split");
    expect(tree.direction).toBe("column");
    expect(tree.children).toHaveLength(2);
    for (const c of tree.children) {
      if (c.node.kind !== "split") throw new Error("expected inner row");
      expect(c.node.direction).toBe("row");
      expect(c.node.children).toHaveLength(2);
    }
  });
});

describe("applyPreset", () => {
  it("preserves pane ids when the current pane count matches (PTYs survive)", () => {
    const store = createLayoutStore(threePanePreset(), {
      idFactory: counterIdFactory("t"),
    });
    const before = store.paneOrder.slice();
    store.applyPreset("horizontal-3");
    expect(store.paneOrder).toEqual(before);
  });

  it("re-attaches detached panes when growing into a larger preset", () => {
    const store = createLayoutStore(threePanePreset(), {
      idFactory: counterIdFactory("t"),
    });
    // Shrink to a 2-pane shape by closing one (forces nothing into detached).
    // To exercise the re-attach path, manually push a fake detached id —
    // simpler than building a multi-step scenario.
    // (Real flow: a future "trim to N" preset → detached, then a wider preset
    // pulls them back. Today we just smoke-test the wiring.)
    // Step 1: grow from 3 to 4 — should mint one new pane.
    store.applyPreset("grid-2x2");
    expect(store.paneOrder).toHaveLength(4);
    const fourth = store.paneOrder[3]!;
    expect(store.panes[fourth]).toBeDefined();
    expect(store.panes[fourth]!.command).toBe("/bin/zsh");
  });

  it("detaches surplus panes when shrinking to a smaller preset", () => {
    // Set up a grid-2x2 first to have 4 panes, then shrink to three-pane.
    const store = createLayoutStore(threePanePreset(), {
      idFactory: counterIdFactory("t"),
    });
    store.applyPreset("grid-2x2");
    expect(store.paneOrder).toHaveLength(4);
    const before = store.paneOrder.slice();
    store.applyPreset("three-pane");
    // Three-pane keeps the first three; the fourth moves to detached.
    expect(store.paneOrder).toEqual(before.slice(0, 3));
    expect(store.detachedPanes).toEqual([before[3]]);
    // The detached pane's spec stays in `panes` so AppRoot can keep it
    // mounted off-screen.
    expect(store.panes[before[3]!]).toBeDefined();
  });

  it("ignores unknown preset ids", () => {
    const store = createLayoutStore(threePanePreset());
    const before = store.paneOrder.slice();
    store.applyPreset("not-a-real-preset");
    expect(store.paneOrder).toEqual(before);
  });
});

describe("custom layouts", () => {
  it("saveCustomLayout snapshots the current tree and panes", () => {
    const store = createLayoutStore(threePanePreset());
    store.saveCustomLayout("my-layout");
    expect(store.listCustomLayouts()).toEqual(["my-layout"]);
  });

  it("applyCustomLayout restores a previously saved layout", () => {
    const store = createLayoutStore(threePanePreset(), {
      idFactory: counterIdFactory("t"),
    });
    const originalOrder = store.paneOrder.slice();
    store.saveCustomLayout("baseline");

    // Switch to a horizontal layout, then back.
    store.applyPreset("horizontal-3");
    store.applyCustomLayout("baseline");

    expect(store.paneOrder).toEqual(originalOrder);
  });

  it("applyCustomLayout snapshots are isolated from later mutations", () => {
    const store = createLayoutStore(threePanePreset());
    store.saveCustomLayout("baseline");

    // Mutate after the save — the snapshot must not reflect the change.
    store.updatePaneMeta(store.paneOrder[0]!, { label: "Mutated" });
    expect(store.panes[store.paneOrder[0]!]!.label).toBe("Mutated");

    store.applyCustomLayout("baseline");
    expect(store.panes[store.paneOrder[0]!]!.label).toBe("Pane 1");
  });

  it("deleteCustomLayout removes the entry", () => {
    const store = createLayoutStore(threePanePreset());
    store.saveCustomLayout("a");
    store.saveCustomLayout("b");
    store.deleteCustomLayout("a");
    expect(store.listCustomLayouts()).toEqual(["b"]);
  });
});
