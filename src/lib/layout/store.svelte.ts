// Reactive layout store wrapping the pure transforms in `./tree.ts`.
//
// Svelte 5 runes only work inside `.svelte` and `.svelte.ts` modules, so this
// file is named with the `.svelte.ts` extension. Consumers import from
// `./store.svelte`. The store is a factory (`createLayoutStore`) rather than
// a module-level singleton so tests can spin up isolated instances.

import { SvelteMap } from "svelte/reactivity";

import {
  adjustSplitWeights,
  dfsLeafOrder,
  duplicatePane as duplicatePaneTree,
  findParentSplit,
  pickFocusFallback,
  rectsFor as rectsForTree,
  removePane as removePaneTree,
  reorderSiblings as reorderSiblingsTree,
  splitLeaf,
  splittersFor as splittersForTree,
  type Direction,
  type LayoutNode,
  type LayoutSnapshot,
  type PaneId,
  type ParentSplitInfo,
  type PaneSpec,
  type Rect,
  type SplitNodeId,
  type SplitterInfo,
} from "./tree";
import { getPreset } from "./presets";

/**
 * Optional inputs for `splitPane` / `duplicatePane`. The caller can override
 * the default `/bin/zsh -l` spec — useful when PR-14 wires in config-driven
 * pane definitions.
 */
export interface NewPaneInput {
  label?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  ssh?: PaneSpec["ssh"];
}

export interface LayoutStore {
  readonly tree: LayoutNode;
  readonly panes: Readonly<Record<PaneId, PaneSpec>>;
  readonly focusedPaneId: PaneId;
  /** DFS leaf order — drives Cmd+1..N and "Pane N" labelling. */
  readonly paneOrder: readonly PaneId[];
  /** In-memory custom layout snapshots. Phase 4 wires UI; PR-15 will persist. */
  readonly customLayouts: ReadonlyMap<string, LayoutSnapshot>;
  /**
   * Pane ids that were dropped from the tree by a preset switch but whose
   * PTYs we want to keep alive (spec §5 "レイアウト切替時にペインの内容は保持").
   * Rendered off-screen by AppRoot so the Pane component stays mounted.
   */
  readonly detachedPanes: readonly PaneId[];
  /**
   * For each pane, the id of the last pane it sent text to (spec §16
   * status bar — "current send target"). Updated by AppRoot whenever a
   * send completes. Not persisted; lives only as long as the store.
   */
  readonly lastSendTarget: Readonly<Record<PaneId, PaneId>>;

  // Queries
  rectsFor(viewport: { w: number; h: number }, gutterPx: number): Record<PaneId, Rect>;
  splittersFor(viewport: { w: number; h: number }, gutterPx: number): SplitterInfo[];
  /** Where the pane sits in the tree — direction + index of its parent split. */
  parentSplitOf(paneId: PaneId): ParentSplitInfo | null;

  // Actions
  focus(paneId: PaneId): void;
  /**
   * Insert a new pane next to `targetPaneId`. Returns the freshly-minted
   * pane id so the caller (e.g. UI) can focus it or pass it to the next
   * step. No-op (returns null) when the target is missing.
   */
  splitPane(
    targetPaneId: PaneId,
    direction: Direction,
    position?: "before" | "after",
    spec?: NewPaneInput
  ): PaneId | null;
  /** Duplicate the source pane's spec; returns the new pane id. */
  duplicatePane(targetPaneId: PaneId, direction?: Direction): PaneId | null;
  /**
   * Remove a pane. Returns `true` on success, `false` if removal would
   * empty the tree (the store refuses — the spec requires ≥ 1 pane).
   */
  closePane(paneId: PaneId): boolean;
  reorderSiblings(splitId: SplitNodeId, fromIdx: number, toIdx: number): void;
  /**
   * Move weight between two adjacent siblings of `splitId`. `deltaFraction`
   * is the share of the *combined* sibling weight to move from left to right
   * (positive grows right). Other siblings remain at their current weight.
   */
  setSplitWeight(
    splitId: SplitNodeId,
    leftIdx: number,
    rightIdx: number,
    deltaFraction: number
  ): void;
  /** Merge `patch` into the named PaneSpec — label / command / cwd / env edits. */
  updatePaneMeta(paneId: PaneId, patch: Partial<Omit<PaneSpec, "id">>): void;
  /** Record that `source` last sent text to `target`. */
  recordSend(source: PaneId, target: PaneId): void;

  /**
   * Reshape the tree to match a preset (see `./presets.ts`).
   *   - Same pane count as current: reuses existing pane ids → PTYs survive
   *     verbatim (spec §5 "レイアウト切替時にペインの内容は保持").
   *   - Fewer current panes than the preset wants: re-attaches detached panes
   *     first, then mints new defaults.
   *   - More current panes than the preset wants: surplus panes move into
   *     `detachedPanes` (PaneSpec + PTY stay alive, off-tree).
   */
  applyPreset(presetId: string): void;
  /** Save a deep clone of the current tree + panes under `name` (in-memory). */
  saveCustomLayout(name: string): void;
  /** Restore a saved layout. Panes not in the snapshot become detached. */
  applyCustomLayout(name: string): void;
  /** Remove the saved layout. No-op if absent. */
  deleteCustomLayout(name: string): void;
  /** Names of every saved custom layout, in insertion order. */
  listCustomLayouts(): string[];

  /**
   * Deep-cloned snapshot of the whole store — tree + panes + focus +
   * customLayouts — for session persistence. The clone is the source of
   * truth at call time; later mutations don't reach the returned value.
   */
  exportSnapshot(): {
    tree: LayoutNode;
    panes: Record<PaneId, PaneSpec>;
    focusedPaneId: PaneId;
    customLayouts: Record<string, LayoutSnapshot>;
  };
  /**
   * Replace the entire store from a previously-exported snapshot. Used by
   * session restore on launch. Custom layouts are repopulated by name.
   */
  importSnapshot(snap: {
    tree: LayoutNode;
    panes: Record<PaneId, PaneSpec>;
    focusedPaneId: PaneId;
    customLayouts?: Record<string, LayoutSnapshot>;
  }): void;
}

/** Built-in default for newly-spawned panes. Used when no config-driven
 *  override has been wired in (tests, very-early startup before config loads). */
export function defaultPaneSpec(label: string, id: PaneId): PaneSpec {
  return {
    id,
    label,
    command: "/bin/zsh",
    args: ["-l"],
  };
}

/**
 * Factory for fresh pane / split ids. Defaults to `crypto.randomUUID()`.
 * Tests inject deterministic counters via the `idFactory` option.
 */
export interface IdFactory {
  pane(): PaneId;
  split(): SplitNodeId;
}

function defaultIdFactory(): IdFactory {
  return {
    pane: () => crypto.randomUUID(),
    split: () => crypto.randomUUID(),
  };
}

export interface CreateLayoutStoreOptions {
  idFactory?: IdFactory;
  /**
   * Factory for the default pane spec applied when a new pane is minted
   * with no caller-supplied `command`. AppRoot injects a config-driven
   * version here so user settings (`defaultPane`) flow into newly created
   * panes (preset growth, blank duplicates) without each call site
   * threading the config through.
   */
  defaultPaneSpec?: (label: string, id: PaneId) => PaneSpec;
}

export function createLayoutStore(
  initial: LayoutSnapshot,
  options: CreateLayoutStoreOptions = {}
): LayoutStore {
  const ids = options.idFactory ?? defaultIdFactory();
  const makeDefaultSpec = options.defaultPaneSpec ?? defaultPaneSpec;

  // Treat the initial snapshot as the *source of truth*; defensive-clone the
  // panes record so callers that mutate the original literal can't bleed
  // through (the tree itself is structurally shared until a transform runs).
  let tree: LayoutNode = $state(initial.tree);
  let panes: Record<PaneId, PaneSpec> = $state({ ...initial.panes });
  let focusedPaneId: PaneId = $state(initial.focusedPaneId);
  // Track detached panes so phase 4 preset-switching can stash overflow.
  // Mutated via push/splice — Svelte 5's $state proxy detects array mutations
  // so consumers still re-react.
  const detachedPanes: PaneId[] = $state([]);
  // `source pane id → last target pane id` — drives the status bar's
  // "→ target" line. Stored as a plain object behind $state so writes
  // create new refs and downstream `$derived` recalculates.
  let lastSendTarget: Record<PaneId, PaneId> = $state({});
  // Reactive Map — Svelte 5's runes don't deep-react to plain Map mutations.
  const customLayouts = new SvelteMap<string, LayoutSnapshot>();

  function ensureFocusedExists(): void {
    if (focusedPaneId in panes && dfsLeafOrder(tree).includes(focusedPaneId)) return;
    const fallback = dfsLeafOrder(tree)[0];
    if (fallback) focusedPaneId = fallback;
  }

  function autoLabel(): string {
    return `Pane ${Object.keys(panes).length + 1}`;
  }

  // Validate the initial snapshot: focusedPaneId must point at an actual
  // leaf. Wrapped in the helper above so the `$state` reads happen inside a
  // closure (Svelte's `state_referenced_locally` warning fires otherwise).
  ensureFocusedExists();

  function mintPaneSpec(input?: NewPaneInput): PaneSpec {
    const id = ids.pane();
    const base = makeDefaultSpec(input?.label ?? autoLabel(), id);
    return {
      ...base,
      ...(input?.command !== undefined && { command: input.command }),
      ...(input?.args !== undefined && { args: input.args }),
      ...(input?.cwd !== undefined && { cwd: input.cwd }),
      ...(input?.env !== undefined && { env: input.env }),
      ...(input?.ssh !== undefined && { ssh: input.ssh }),
    };
  }

  return {
    get tree() {
      return tree;
    },
    get panes() {
      return panes;
    },
    get focusedPaneId() {
      return focusedPaneId;
    },
    get paneOrder() {
      return dfsLeafOrder(tree);
    },
    get customLayouts() {
      return customLayouts;
    },
    get detachedPanes() {
      return detachedPanes;
    },
    get lastSendTarget() {
      return lastSendTarget;
    },

    rectsFor(viewport, gutterPx) {
      return rectsForTree(tree, viewport, gutterPx);
    },
    splittersFor(viewport, gutterPx) {
      return splittersForTree(tree, viewport, gutterPx);
    },
    parentSplitOf(paneId) {
      return findParentSplit(tree, paneId);
    },

    focus(paneId) {
      if (paneId in panes) focusedPaneId = paneId;
    },

    splitPane(targetPaneId, direction, position = "after", specInput) {
      if (!(targetPaneId in panes)) return null;
      const spec = mintPaneSpec(specInput);
      const nextTree = splitLeaf(tree, targetPaneId, direction, spec.id, ids.split(), position);
      tree = nextTree;
      panes = { ...panes, [spec.id]: spec };
      return spec.id;
    },

    duplicatePane(targetPaneId, direction = "row") {
      const source = panes[targetPaneId];
      if (!source) return null;
      const newId = ids.pane();
      // Copy the source's command / args / cwd / env so the duplicate spawns
      // the same kind of process. Label gets a "(copy)" suffix to keep them
      // distinguishable in the header / Cmd+1..N labelling.
      const spec: PaneSpec = {
        id: newId,
        label: `${source.label} (copy)`,
        ...(source.command !== undefined && { command: source.command }),
        ...(source.args !== undefined && { args: source.args }),
        ...(source.cwd !== undefined && { cwd: source.cwd }),
        ...(source.env !== undefined && { env: source.env }),
        ...(source.ssh !== undefined && { ssh: { ...source.ssh } }),
      };
      const nextTree = duplicatePaneTree(tree, targetPaneId, newId, direction, ids.split());
      tree = nextTree;
      panes = { ...panes, [newId]: spec };
      return newId;
    },

    closePane(paneId) {
      if (!(paneId in panes)) return false;
      const order = dfsLeafOrder(tree);
      if (order.length <= 1) return false; // spec §5: never leave zero panes.
      const wasFocused = focusedPaneId === paneId;
      const fallback = wasFocused ? pickFocusFallback(tree, paneId) : null;
      const next = removePaneTree(tree, paneId);
      if (!next) return false;
      tree = next;
      const remaining = { ...panes };
      delete remaining[paneId];
      panes = remaining;
      if (wasFocused && fallback) focusedPaneId = fallback;
      ensureFocusedExists();
      return true;
    },

    reorderSiblings(splitId, fromIdx, toIdx) {
      tree = reorderSiblingsTree(tree, splitId, fromIdx, toIdx);
    },

    setSplitWeight(splitId, leftIdx, rightIdx, deltaFraction) {
      tree = adjustSplitWeights(tree, splitId, leftIdx, rightIdx, deltaFraction);
    },

    updatePaneMeta(paneId, patch) {
      const existing = panes[paneId];
      if (!existing) return;
      panes = { ...panes, [paneId]: { ...existing, ...patch } };
    },

    recordSend(source, target) {
      if (source === target) return;
      lastSendTarget = { ...lastSendTarget, [source]: target };
    },

    applyPreset(presetId) {
      const preset = getPreset(presetId);
      if (!preset) return;
      const currentIds = dfsLeafOrder(tree);
      if (currentIds.length === preset.paneCount) {
        // Equal — reuse current pane ids verbatim. Pane components stay
        // mounted because the panes record didn't change.
        tree = preset.build(currentIds, ids.split);
      } else if (currentIds.length < preset.paneCount) {
        const need = preset.paneCount - currentIds.length;
        // Re-attach detached panes first (their PTYs are still alive).
        const reattach = detachedPanes.slice(0, need);
        detachedPanes.splice(0, reattach.length);
        const remaining = need - reattach.length;
        const fresh: PaneId[] = [];
        for (let i = 0; i < remaining; i++) {
          const id = ids.pane();
          const spec = makeDefaultSpec(autoLabel(), id);
          panes = { ...panes, [id]: spec };
          fresh.push(id);
        }
        tree = preset.build([...currentIds, ...reattach, ...fresh], ids.split);
      } else {
        // Too many — detach the trailing ids. Their PaneSpecs stay in
        // `panes` so AppRoot continues to mount them (off-screen).
        const keep = currentIds.slice(0, preset.paneCount);
        const detach = currentIds.slice(preset.paneCount);
        tree = preset.build(keep, ids.split);
        detachedPanes.push(...detach);
      }
      ensureFocusedExists();
    },

    saveCustomLayout(name) {
      // `$state.snapshot` unwraps Svelte 5's reactive proxy into a plain
      // POJO. `structuredClone` here would throw `DataCloneError` because
      // the proxy carries non-cloneable internals; the cloned snapshot
      // freezes the layout against later mutations.
      customLayouts.set(name, $state.snapshot({ tree, panes, focusedPaneId }));
    },

    applyCustomLayout(name) {
      const snap = customLayouts.get(name);
      if (!snap) return;
      const snapLeafIds = new Set(dfsLeafOrder(snap.tree));
      // Move any current pane that isn't in the new tree into `detachedPanes`
      // so its PTY survives (the user can re-apply the previous layout to
      // get it back, until in-memory layouts are persisted in PR-15).
      const detach = dfsLeafOrder(tree).filter((id) => !snapLeafIds.has(id));
      // Union the panes records — snapshot's specs win for shared ids.
      // `$state.snapshot` on the inner record so mutations on either side
      // stay isolated (and we don't trip structuredClone on the proxy).
      panes = { ...panes, ...$state.snapshot(snap.panes) };
      tree = $state.snapshot(snap.tree);
      if (detach.length > 0) detachedPanes.push(...detach);
      focusedPaneId = snap.focusedPaneId;
      ensureFocusedExists();
    },

    exportSnapshot() {
      // `$state.snapshot` rather than `structuredClone` — the store's
      // reactive proxy isn't structurally cloneable, and session save
      // would throw `DataCloneError` the moment the user picked
      // "Save session as…".
      const cl: Record<string, LayoutSnapshot> = {};
      for (const [key, snap] of customLayouts) {
        cl[key] = $state.snapshot(snap);
      }
      return {
        tree: $state.snapshot(tree),
        panes: $state.snapshot(panes),
        focusedPaneId,
        customLayouts: cl,
      };
    },

    importSnapshot(snap) {
      tree = $state.snapshot(snap.tree);
      panes = $state.snapshot(snap.panes);
      focusedPaneId = snap.focusedPaneId;
      detachedPanes.splice(0, detachedPanes.length);
      customLayouts.clear();
      if (snap.customLayouts) {
        for (const [key, value] of Object.entries(snap.customLayouts)) {
          customLayouts.set(key, $state.snapshot(value));
        }
      }
      ensureFocusedExists();
    },

    deleteCustomLayout(name) {
      customLayouts.delete(name);
    },

    listCustomLayouts() {
      return Array.from(customLayouts.keys());
    },
  };
}
