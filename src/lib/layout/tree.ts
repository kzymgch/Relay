// Recursive split-tree layout model (spec §5).
//
// Pure, no Svelte dependency. The reactive store in `./store.ts` wraps these
// transforms; consumers in tests and presets can call them directly.
//
// Invariants every value returned by a transform satisfies:
//   - Splits hold >= 2 children (1-child splits are collapsed into the child).
//   - No same-direction split is nested directly inside another (e.g. a "row"
//     split inside a "row" split is flattened into one row with merged
//     children + redistributed weights). Different-direction nesting is
//     allowed and is what makes the tree expressive.
//   - Weights are arbitrary positive numbers (flex-grow semantics). They are
//     NOT normalized to sum=1 — repeated drag operations would otherwise
//     accumulate float drift.

export type PaneId = string;
export type SplitNodeId = string;
/**
 * `row` lays children out left-to-right (horizontal arrangement, vertical
 * resize lines). `column` lays them top-to-bottom (vertical arrangement,
 * horizontal resize lines). The names mirror CSS `flex-direction`.
 */
export type Direction = "row" | "column";

export interface LeafNode {
  kind: "leaf";
  paneId: PaneId;
}

export interface SplitChild {
  node: LayoutNode;
  weight: number;
}

export interface SplitNode {
  kind: "split";
  id: SplitNodeId;
  direction: Direction;
  children: SplitChild[];
}

export type LayoutNode = LeafNode | SplitNode;

/** SSH connection parameters for a remote pane. Only `host` is required; the
 *  rest fall back to `~/.ssh/config` lookup at connect time, then to defaults
 *  (port 22, current OS user). Passwords are not stored here — set
 *  `useKeychainPassword` and store the secret via `ssh_keychain_set`. */
export interface SshTarget {
  host: string;
  port?: number;
  user?: string;
  identityPath?: string;
  sshConfigAlias?: string;
  useKeychainPassword?: boolean;
  /** When false, disconnect drops the pane to `exited`; when true (default),
   *  the backend retries with exponential backoff. */
  autoReconnect?: boolean;
}

export interface PaneSpec {
  id: PaneId;
  label: string;
  /** Local command. Required for local panes; ignored when `ssh` is set. */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** When present, this pane is a remote SSH pane. */
  ssh?: SshTarget;
}

export interface LayoutSnapshot {
  tree: LayoutNode;
  panes: Record<PaneId, PaneSpec>;
  focusedPaneId: PaneId;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SplitterInfo {
  /** Stable key for {#each}. */
  id: string;
  splitId: SplitNodeId;
  /** The splitter sits between `leftIdx` and `rightIdx` (= leftIdx + 1). */
  leftIdx: number;
  rightIdx: number;
  direction: Direction;
  /** Position of the splitter's top-left in viewport coords (px). */
  x: number;
  y: number;
  /** Cross-axis length (px). */
  length: number;
  /**
   * Pixels available along the split axis for *children* of this split,
   * after deducting gutters. Callers convert drag delta → `deltaFraction`
   * via `delta / parentAxisSize` before invoking `adjustSplitWeights`.
   */
  parentAxisSize: number;
}

// ---------- Constructors ----------

export function makeLeaf(paneId: PaneId): LeafNode {
  return { kind: "leaf", paneId };
}

export function makeSplit(
  id: SplitNodeId,
  direction: Direction,
  children: SplitChild[]
): SplitNode {
  return { kind: "split", id, direction, children };
}

// ---------- Walks ----------

/** Path of child indices from root → leaf with `paneId`, or null. */
export function findPath(tree: LayoutNode, paneId: PaneId): number[] | null {
  if (tree.kind === "leaf") return tree.paneId === paneId ? [] : null;
  for (let i = 0; i < tree.children.length; i++) {
    const sub = findPath(tree.children[i]!.node, paneId);
    if (sub) return [i, ...sub];
  }
  return null;
}

/** Visual top-left DFS order of pane ids. Drives Cmd+1..N focus and Pane labelling. */
export function dfsLeafOrder(tree: LayoutNode): PaneId[] {
  if (tree.kind === "leaf") return [tree.paneId];
  return tree.children.flatMap((c) => dfsLeafOrder(c.node));
}

// ---------- Normalization ----------

/**
 * Normalize a subtree: recursively collapse 1-child splits and merge
 * same-direction nested splits into their parent (redistributing weights).
 *
 * Called at the exit of every transform so callers can assume valid trees.
 */
export function flattenSameDirection(node: LayoutNode): LayoutNode {
  if (node.kind === "leaf") return node;

  // Normalize each child first so merging sees fully-normalized subtrees.
  const normalized = node.children.map<SplitChild>((c) => ({
    node: flattenSameDirection(c.node),
    weight: c.weight,
  }));

  // Inline any child that's a same-direction split: replace the child with
  // its own children, scaling their weights to preserve relative proportions.
  const merged: SplitChild[] = [];
  for (const c of normalized) {
    if (c.node.kind === "split" && c.node.direction === node.direction) {
      const innerTotal = c.node.children.reduce((s, x) => s + x.weight, 0);
      if (innerTotal > 0) {
        for (const innerChild of c.node.children) {
          merged.push({
            node: innerChild.node,
            weight: (c.weight * innerChild.weight) / innerTotal,
          });
        }
      } else {
        // Defensive: degenerate weights — distribute evenly.
        for (const innerChild of c.node.children) {
          merged.push({ node: innerChild.node, weight: c.weight / c.node.children.length });
        }
      }
    } else {
      merged.push(c);
    }
  }

  // A 1-child split is equivalent to its sole child.
  if (merged.length === 1) return merged[0]!.node;

  return { kind: "split", id: node.id, direction: node.direction, children: merged };
}

// ---------- Transforms ----------

/**
 * Replace the leaf with `targetPaneId` by a split containing the original
 * leaf and a new leaf carrying `newPaneId`. The new leaf goes `before` or
 * `after` the original within the split.
 *
 * Callers supply `newSplitId` and `newPaneId` so tests and the store can
 * control id generation (the store passes `crypto.randomUUID()`).
 */
export function splitLeaf(
  tree: LayoutNode,
  targetPaneId: PaneId,
  direction: Direction,
  newPaneId: PaneId,
  newSplitId: SplitNodeId,
  position: "before" | "after"
): LayoutNode {
  function visit(node: LayoutNode): LayoutNode {
    if (node.kind === "leaf") {
      if (node.paneId !== targetPaneId) return node;
      const existing: SplitChild = { node, weight: 1 };
      const fresh: SplitChild = { node: makeLeaf(newPaneId), weight: 1 };
      const children = position === "before" ? [fresh, existing] : [existing, fresh];
      return makeSplit(newSplitId, direction, children);
    }
    let changed = false;
    const next = node.children.map<SplitChild>((c) => {
      const nn = visit(c.node);
      if (nn !== c.node) changed = true;
      return { node: nn, weight: c.weight };
    });
    if (!changed) return node;
    return { ...node, children: next };
  }
  return flattenSameDirection(visit(tree));
}

/**
 * Remove the leaf with `paneId`. Returns the new tree, or `null` if it would
 * become empty (caller's responsibility to enforce "≥ 1 pane" UX gates).
 */
export function removePane(tree: LayoutNode, paneId: PaneId): LayoutNode | null {
  function visit(node: LayoutNode): LayoutNode | null {
    if (node.kind === "leaf") return node.paneId === paneId ? null : node;
    const next: SplitChild[] = [];
    for (const c of node.children) {
      const n = visit(c.node);
      if (n) next.push({ node: n, weight: c.weight });
    }
    if (next.length === 0) return null;
    if (next.length === 1) return next[0]!.node;
    return { ...node, children: next };
  }
  const result = visit(tree);
  return result ? flattenSameDirection(result) : null;
}

/**
 * Insert a fresh leaf next to an existing one. Same shape as `splitLeaf` —
 * named separately to make Pane "Duplicate" call sites self-documenting and
 * to keep room for future divergence (e.g. weight inheritance from source).
 */
export function duplicatePane(
  tree: LayoutNode,
  targetPaneId: PaneId,
  newPaneId: PaneId,
  direction: Direction,
  newSplitId: SplitNodeId
): LayoutNode {
  return splitLeaf(tree, targetPaneId, direction, newPaneId, newSplitId, "after");
}

/** Move a child within its split to a new index. */
export function reorderSiblings(
  tree: LayoutNode,
  splitId: SplitNodeId,
  fromIdx: number,
  toIdx: number
): LayoutNode {
  function visit(node: LayoutNode): LayoutNode {
    if (node.kind === "leaf") return node;
    if (node.id === splitId) {
      if (fromIdx === toIdx) return node;
      const len = node.children.length;
      if (fromIdx < 0 || fromIdx >= len || toIdx < 0 || toIdx >= len) {
        throw new RangeError(
          `reorderSiblings: index out of range (from=${fromIdx}, to=${toIdx}, len=${len})`
        );
      }
      const next = node.children.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved!);
      return { ...node, children: next };
    }
    let changed = false;
    const nextChildren = node.children.map<SplitChild>((c) => {
      const n = visit(c.node);
      if (n !== c.node) changed = true;
      return { node: n, weight: c.weight };
    });
    if (!changed) return node;
    return { ...node, children: nextChildren };
  }
  return flattenSameDirection(visit(tree));
}

/**
 * Shift weight between two adjacent children of `splitId`.
 *
 * `deltaFraction` is a signed share of the *combined* weight of the two
 * children to move from `leftIdx` toward `rightIdx` — positive grows the
 * right sibling, negative grows the left. Other siblings are untouched, so
 * dragging one boundary never resizes a third pane.
 *
 * Clamps to `minWeight` (default 0.05) — the caller may also impose a px
 * floor before computing the fraction.
 */
export function adjustSplitWeights(
  tree: LayoutNode,
  splitId: SplitNodeId,
  leftIdx: number,
  rightIdx: number,
  deltaFraction: number,
  minWeight = 0.05
): LayoutNode {
  function visit(node: LayoutNode): LayoutNode {
    if (node.kind === "leaf") return node;
    if (node.id === splitId) {
      const a = node.children[leftIdx];
      const b = node.children[rightIdx];
      if (!a || !b) {
        throw new RangeError(
          `adjustSplitWeights: bad index ${leftIdx}/${rightIdx} (len=${node.children.length})`
        );
      }
      const combined = a.weight + b.weight;
      const delta = combined * deltaFraction;
      const newLeft = a.weight - delta;
      const newRight = b.weight + delta;
      if (newLeft < minWeight || newRight < minWeight) return node;
      const next = node.children.slice();
      next[leftIdx] = { node: a.node, weight: newLeft };
      next[rightIdx] = { node: b.node, weight: newRight };
      return { ...node, children: next };
    }
    let changed = false;
    const nextChildren = node.children.map<SplitChild>((c) => {
      const n = visit(c.node);
      if (n !== c.node) changed = true;
      return { node: n, weight: c.weight };
    });
    if (!changed) return node;
    return { ...node, children: nextChildren };
  }
  // No structural change is possible — skip normalization to save work.
  return visit(tree);
}

/** Update the pane id at a leaf — used by preset application to re-key the tree. */
export function rekeyLeaf(tree: LayoutNode, oldPaneId: PaneId, newPaneId: PaneId): LayoutNode {
  function visit(node: LayoutNode): LayoutNode {
    if (node.kind === "leaf") {
      return node.paneId === oldPaneId ? makeLeaf(newPaneId) : node;
    }
    let changed = false;
    const nextChildren = node.children.map<SplitChild>((c) => {
      const n = visit(c.node);
      if (n !== c.node) changed = true;
      return { node: n, weight: c.weight };
    });
    if (!changed) return node;
    return { ...node, children: nextChildren };
  }
  return visit(tree);
}

/** Where a leaf sits in the tree — needed by reorder UI. `null` if absent. */
export interface ParentSplitInfo {
  splitId: SplitNodeId;
  direction: Direction;
  /** Position of the leaf within `siblingCount` children. */
  idx: number;
  siblingCount: number;
}

export function findParentSplit(tree: LayoutNode, paneId: PaneId): ParentSplitInfo | null {
  const path = findPath(tree, paneId);
  if (!path || path.length === 0) return null;
  let cur: LayoutNode = tree;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur.kind !== "split") return null;
    cur = cur.children[path[i]!]!.node;
  }
  if (cur.kind !== "split") return null;
  return {
    splitId: cur.id,
    direction: cur.direction,
    idx: path[path.length - 1]!,
    siblingCount: cur.children.length,
  };
}

// ---------- Focus fallback ----------

/**
 * Choose the next-focused pane when `removedPaneId` is closed. Walks from the
 * leaf back toward the root, picking the deepest left-leaf of the previous
 * sibling first, then the next sibling, then climbing one level and trying
 * again. Mirrors tmux's "pick the closest neighbor that still exists" rule.
 *
 * Returns `null` if the removal would empty the tree.
 */
export function pickFocusFallback(tree: LayoutNode, removedPaneId: PaneId): PaneId | null {
  const path = findPath(tree, removedPaneId);
  if (!path) return null;
  if (path.length === 0) return null; // The tree is a single leaf.

  // Build the ancestor stack.
  const ancestors: SplitNode[] = [];
  let cur: LayoutNode = tree;
  for (const idx of path) {
    if (cur.kind !== "split") return null;
    ancestors.push(cur);
    cur = cur.children[idx]!.node;
  }

  for (let depth = ancestors.length - 1; depth >= 0; depth--) {
    const parent = ancestors[depth]!;
    const idx = path[depth]!;
    for (const sIdx of [idx - 1, idx + 1]) {
      if (sIdx >= 0 && sIdx < parent.children.length) {
        const order = dfsLeafOrder(parent.children[sIdx]!.node);
        if (order.length > 0) return order[0]!;
      }
    }
  }
  return null;
}

// ---------- Layout queries ----------

/**
 * Compute every leaf's absolute pixel rect within `viewport`.
 *
 * Integer-rounded: each child's size is `floor(weight ratio × usable axis)`;
 * the rounding remainder is absorbed by the last child so the tree exactly
 * fills the viewport with no 1px gap on the trailing edge.
 */
export function rectsFor(
  tree: LayoutNode,
  viewport: { w: number; h: number },
  gutterPx: number
): Record<PaneId, Rect> {
  const out: Record<PaneId, Rect> = {};
  layoutInto(tree, { x: 0, y: 0, w: viewport.w, h: viewport.h }, gutterPx, out);
  return out;
}

function layoutInto(node: LayoutNode, rect: Rect, gutter: number, out: Record<PaneId, Rect>): void {
  if (node.kind === "leaf") {
    out[node.paneId] = rect;
    return;
  }
  const childSizes = computeChildSizes(node, rect, gutter);
  let cursor = node.direction === "row" ? rect.x : rect.y;
  for (let i = 0; i < node.children.length; i++) {
    const sz = childSizes[i]!;
    const childRect: Rect =
      node.direction === "row"
        ? { x: cursor, y: rect.y, w: sz, h: rect.h }
        : { x: rect.x, y: cursor, w: rect.w, h: sz };
    layoutInto(node.children[i]!.node, childRect, gutter, out);
    cursor += sz + gutter;
  }
}

/** Compute splitter rects between adjacent siblings, recursively. */
export function splittersFor(
  tree: LayoutNode,
  viewport: { w: number; h: number },
  gutterPx: number
): SplitterInfo[] {
  const out: SplitterInfo[] = [];
  collectSplitters(tree, { x: 0, y: 0, w: viewport.w, h: viewport.h }, gutterPx, out);
  return out;
}

function collectSplitters(node: LayoutNode, rect: Rect, gutter: number, out: SplitterInfo[]): void {
  if (node.kind === "leaf") return;
  const childSizes = computeChildSizes(node, rect, gutter);
  const usable = childSizes.reduce((s, v) => s + v, 0);
  let cursor = node.direction === "row" ? rect.x : rect.y;
  for (let i = 0; i < node.children.length; i++) {
    const sz = childSizes[i]!;
    // Emit a splitter between children i and i+1.
    if (i < node.children.length - 1) {
      const splitterStart = cursor + sz;
      const info: SplitterInfo =
        node.direction === "row"
          ? {
              id: `${node.id}:${i}-${i + 1}`,
              splitId: node.id,
              leftIdx: i,
              rightIdx: i + 1,
              direction: "row",
              x: splitterStart,
              y: rect.y,
              length: rect.h,
              parentAxisSize: usable,
            }
          : {
              id: `${node.id}:${i}-${i + 1}`,
              splitId: node.id,
              leftIdx: i,
              rightIdx: i + 1,
              direction: "column",
              x: rect.x,
              y: splitterStart,
              length: rect.w,
              parentAxisSize: usable,
            };
      out.push(info);
    }
    const childRect: Rect =
      node.direction === "row"
        ? { x: cursor, y: rect.y, w: sz, h: rect.h }
        : { x: rect.x, y: cursor, w: rect.w, h: sz };
    collectSplitters(node.children[i]!.node, childRect, gutter, out);
    cursor += sz + gutter;
  }
}

/**
 * Distribute the available axis size (minus gutters) across children by
 * weight, floor-rounding each share and absorbing the leftover px in the
 * last child. Shared between `rectsFor` and `splittersFor` so a splitter's
 * `x`/`y` lines up exactly with the boundary of two pane rects.
 */
function computeChildSizes(node: SplitNode, rect: Rect, gutter: number): number[] {
  const axisSize = node.direction === "row" ? rect.w : rect.h;
  const totalGutter = gutter * (node.children.length - 1);
  const usable = Math.max(0, axisSize - totalGutter);
  const totalWeight = node.children.reduce((s, c) => s + c.weight, 0);
  if (totalWeight <= 0) {
    return node.children.map(() => 0);
  }
  const raw = node.children.map((c) => (usable * c.weight) / totalWeight);
  const intSizes = raw.map((s) => Math.floor(s));
  const remainder = usable - intSizes.reduce((s, v) => s + v, 0);
  intSizes[intSizes.length - 1] = (intSizes[intSizes.length - 1] ?? 0) + remainder;
  return intSizes;
}
