<script lang="ts">
  // Drag handle that sits between two adjacent siblings of a split node and
  // shifts weight between them as the user drags. Lives in an absolute-
  // positioned overlay above the panes (see `splitter.css` for the z-index
  // plan). Pure pointer events — no third-party drag library — so input
  // semantics stay predictable and Vitest can drive them via fireEvent.

  import type { Direction } from "./tree";

  interface Props {
    /** "row" splits stack children horizontally → vertical resize handle. */
    direction: Direction;
    /** Boundary x/y in viewport coords (px). The handle visually centers on this. */
    x: number;
    y: number;
    /** Cross-axis length of the handle (px). */
    length: number;
    /** Incremental delta (px) along the split axis since the last move. */
    ondrag: (deltaPx: number) => void;
    /** Fired once on pointer release; lets the parent flush any pending state. */
    ondragend?: () => void;
  }

  const { direction, x, y, length, ondrag, ondragend }: Props = $props();

  let dragging = $state(false);
  let lastCoord = 0;

  function axisCoord(e: PointerEvent): number {
    return direction === "row" ? e.clientX : e.clientY;
  }

  function onPointerDown(e: PointerEvent) {
    // Primary button only — keep middle/right click free for the OS / dev tools.
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // jsdom and some older browsers don't implement pointer capture.
      // We still receive pointermove on the document, so soft-fail.
    }
    dragging = true;
    lastCoord = axisCoord(e);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const cur = axisCoord(e);
    const delta = cur - lastCoord;
    if (delta === 0) return;
    lastCoord = cur;
    ondrag(delta);
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const el = e.currentTarget as HTMLElement;
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      // see onPointerDown comment
    }
    ondragend?.();
  }
</script>

<div
  class="splitter"
  class:dragging
  data-direction={direction}
  data-testid="splitter"
  role="separator"
  aria-orientation={direction === "row" ? "vertical" : "horizontal"}
  style="left: {x}px; top: {y}px; {direction === 'row'
    ? `height: ${length}px;`
    : `width: ${length}px;`}"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
></div>
