// Layout presets (spec §5).
//
// CONTRACT NOTE (tests/page.test.ts depends on this): the `three-pane` preset
// must produce pane ids and a DFS order that exactly match the previous
// hardcoded `PaneSlotId = "left" | "topRight" | "bottomRight"` layout. When
// the AppRoot creates the store on mount it calls `threePanePreset()`, so the
// mounted Pane components call `crypto.randomUUID()` in left → topRight →
// bottomRight order. That allocates PTY ids "pane-1", "pane-2", "pane-3"
// under the test's randomUUID mock — every `tests/page.test.ts` assertion
// that hardcodes those ids depends on this contract.

import {
  makeLeaf,
  makeSplit,
  type LayoutNode,
  type LayoutSnapshot,
  type PaneId,
  type PaneSpec,
  type SplitNodeId,
} from "./tree";

const SHELL_COMMAND = "/bin/zsh";
const SHELL_ARGS = ["-l"] as const;

/** Stable, semantic pane ids for the default preset. */
export const THREE_PANE_IDS = {
  left: "slot-left",
  topRight: "slot-top-right",
  bottomRight: "slot-bottom-right",
} as const;

/** Stable split-node ids for the default preset (used by the splitter overlay key). */
export const THREE_PANE_SPLIT_IDS = {
  root: "split-root",
  right: "split-right",
} as const;

/** Initial snapshot used by AppRoot on mount. */
export function threePanePreset(): LayoutSnapshot {
  const left: PaneSpec = {
    id: THREE_PANE_IDS.left,
    label: "Pane 1",
    command: SHELL_COMMAND,
    args: [...SHELL_ARGS],
  };
  const topRight: PaneSpec = {
    id: THREE_PANE_IDS.topRight,
    label: "Pane 2",
    command: SHELL_COMMAND,
    args: [...SHELL_ARGS],
  };
  const bottomRight: PaneSpec = {
    id: THREE_PANE_IDS.bottomRight,
    label: "Pane 3",
    command: SHELL_COMMAND,
    args: [...SHELL_ARGS],
  };

  const tree = makeSplit(THREE_PANE_SPLIT_IDS.root, "row", [
    { node: makeLeaf(left.id), weight: 1 },
    {
      node: makeSplit(THREE_PANE_SPLIT_IDS.right, "column", [
        { node: makeLeaf(topRight.id), weight: 1 },
        { node: makeLeaf(bottomRight.id), weight: 1 },
      ]),
      weight: 1,
    },
  ]);

  return {
    tree,
    panes: {
      [left.id]: left,
      [topRight.id]: topRight,
      [bottomRight.id]: bottomRight,
    },
    focusedPaneId: left.id,
  };
}

/**
 * `applyPreset` (in `store.svelte.ts`) consults this registry to look up the
 * required pane count + tree builder for a given preset id.
 */
export interface PresetDef {
  id: string;
  label: string;
  /** How many panes the preset's `build` consumes. */
  paneCount: number;
  /**
   * Construct the layout tree from exactly `paneCount` ids. `makeSplitId` is
   * supplied by the store so split node ids stay unique across applications.
   */
  build(paneIds: PaneId[], makeSplitId: () => SplitNodeId): LayoutNode;
}

/** Helper: each child has equal weight. */
function eq(node: LayoutNode) {
  return { node, weight: 1 };
}

export const PRESETS: readonly PresetDef[] = [
  {
    id: "three-pane",
    label: "Three-pane (1 + 2)",
    paneCount: 3,
    build: ([a, b, c], makeSplitId) =>
      makeSplit(makeSplitId(), "row", [
        eq(makeLeaf(a!)),
        eq(makeSplit(makeSplitId(), "column", [eq(makeLeaf(b!)), eq(makeLeaf(c!))])),
      ]),
  },
  {
    id: "horizontal-3",
    label: "3 columns",
    paneCount: 3,
    build: ([a, b, c], makeSplitId) =>
      makeSplit(makeSplitId(), "row", [eq(makeLeaf(a!)), eq(makeLeaf(b!)), eq(makeLeaf(c!))]),
  },
  {
    id: "vertical-3",
    label: "3 rows",
    paneCount: 3,
    build: ([a, b, c], makeSplitId) =>
      makeSplit(makeSplitId(), "column", [eq(makeLeaf(a!)), eq(makeLeaf(b!)), eq(makeLeaf(c!))]),
  },
  {
    id: "grid-2x2",
    label: "2 × 2 grid",
    paneCount: 4,
    // DFS order [a, b, c, d] maps to visual reading order top-left, top-right,
    // bottom-left, bottom-right when we wrap row-of-pairs in a column.
    build: ([a, b, c, d], makeSplitId) =>
      makeSplit(makeSplitId(), "column", [
        eq(makeSplit(makeSplitId(), "row", [eq(makeLeaf(a!)), eq(makeLeaf(b!))])),
        eq(makeSplit(makeSplitId(), "row", [eq(makeLeaf(c!)), eq(makeLeaf(d!))])),
      ]),
  },
  {
    id: "main-side",
    label: "Main + 2 sides",
    paneCount: 3,
    // Structurally identical to "three-pane" but with a 2:1 weight so the
    // main pane is visually larger. Listed separately so users can pick the
    // intent quickly from the menu.
    build: ([main, top, bot], makeSplitId) =>
      makeSplit(makeSplitId(), "row", [
        { node: makeLeaf(main!), weight: 2 },
        {
          node: makeSplit(makeSplitId(), "column", [eq(makeLeaf(top!)), eq(makeLeaf(bot!))]),
          weight: 1,
        },
      ]),
  },
] as const;

/** Look up a preset definition by id. */
export function getPreset(id: string): PresetDef | undefined {
  return PRESETS.find((p) => p.id === id);
}
