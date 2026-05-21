<script lang="ts">
  import { onMount } from "svelte";
  import type { Terminal as XTerm } from "@xterm/xterm";

  import "./selection-chip.css";

  /** MIME type stamped on the DataTransfer for same-app DnD. Drop targets
   *  in `Pane.svelte` match on this prefix to reject foreign drags. */
  export const SEND_DND_MIME = "application/x-relay-send";

  interface Props {
    /** Live xterm instance. Selection lookup and positioning hang off it. */
    term: XTerm;
    /** The xterm host div — used as the offsetParent reference for the chip. */
    container: HTMLElement;
    /** Pane id of the source — stamped on the DataTransfer payload. */
    paneId: string;
    /** Human label for the source pane. Threaded onto the payload so the
     *  preview modal can render "{source} → {target}" without a lookup. */
    sourceLabel: string;
  }

  let { term, container, paneId, sourceLabel }: Props = $props();

  let chipEl: HTMLDivElement | undefined = $state();
  let visible = $state(false);
  let pos = $state<{ left: number; top: number }>({ left: 0, top: 0 });
  let selectionText = $state("");

  // Hide the chip while the user is mid-scroll so it doesn't fly across the
  // pane. Re-shown after the scroll settles + selection still exists.
  let scrollSettleTimer: ReturnType<typeof setTimeout> | undefined;

  function compute(): void {
    const sel = term.getSelection();
    if (!sel || sel.length === 0) {
      visible = false;
      selectionText = "";
      return;
    }
    const range = term.getSelectionPosition();
    if (!range) {
      visible = false;
      return;
    }
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      visible = false;
      return;
    }
    // Cell dimensions are derived from the container — `term.cols` /
    // `term.rows` are stable values, and xterm pads the canvas to fill the
    // host. Avoiding the private `_core` API keeps us off the "unstable"
    // upgrade hazard list.
    const cellW = rect.width / term.cols;
    const cellH = rect.height / term.rows;

    // `range.end.y` is buffer-relative. Convert to a viewport row using the
    // scroll offset (`buffer.active.viewportY`) so the chip stays anchored
    // to the visible selection rather than drifting off-screen.
    const viewportY = term.buffer.active.viewportY;
    const viewportEndY = range.end.y - viewportY;

    // Off-screen selections (scrolled out of view) just hide the chip.
    if (viewportEndY < 0 || viewportEndY >= term.rows) {
      visible = false;
      return;
    }

    selectionText = sel;
    // Anchor at the end-of-selection cell, with a small offset so the chip
    // sits below-right of the caret position.
    const left = Math.min(rect.width - 8, range.end.x * cellW + 6);
    const top = Math.min(rect.height - 8, (viewportEndY + 1) * cellH + 2);
    pos = { left, top };
    visible = true;
  }

  function onDragStart(event: DragEvent): void {
    if (!event.dataTransfer) return;
    const text = term.getSelection();
    if (!text || text.length === 0) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("text/plain", text);
    event.dataTransfer.setData(
      SEND_DND_MIME,
      JSON.stringify({ sourcePaneId: paneId, sourceLabel })
    );
    if (chipEl) {
      // Use the chip itself as the drag ghost so the user sees what they're
      // moving instead of a generic browser shadow.
      event.dataTransfer.setDragImage(chipEl, 8, 8);
    }
  }

  function onDragEnd(): void {
    // Return focus to xterm so the next keystroke goes to the shell, not the
    // (still-mounted) chip.
    term.focus();
  }

  onMount(() => {
    const disposers: Array<() => void> = [];

    const selectionDisposable = term.onSelectionChange(() => compute());
    disposers.push(() => selectionDisposable.dispose());

    const scrollDisposable = term.onScroll(() => {
      visible = false;
      if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
      // 120ms keeps the chip out of the way during fast wheel scrolls while
      // re-appearing quickly enough that the user thinks of it as continuous.
      scrollSettleTimer = setTimeout(() => {
        scrollSettleTimer = undefined;
        compute();
      }, 120);
    });
    disposers.push(() => scrollDisposable.dispose());

    const observer = new ResizeObserver(() => compute());
    observer.observe(container);
    disposers.push(() => observer.disconnect());

    compute();

    return () => {
      for (const d of disposers) d();
      if (scrollSettleTimer) {
        clearTimeout(scrollSettleTimer);
        scrollSettleTimer = undefined;
      }
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={chipEl}
  class="selection-chip"
  hidden={!visible}
  style:left="{pos.left}px"
  style:top="{pos.top}px"
  draggable="true"
  ondragstart={onDragStart}
  ondragend={onDragEnd}
  data-testid="selection-chip"
  data-pane-id={paneId}
  tabindex="-1"
  title="Drag to another pane to send"
>
  Send · {selectionText.length} char{selectionText.length === 1 ? "" : "s"}
</div>
