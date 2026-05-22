<script lang="ts">
  import { onMount } from "svelte";
  import { Terminal as XTerm } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { SearchAddon } from "@xterm/addon-search";
  import { SerializeAddon } from "@xterm/addon-serialize";
  import "@xterm/xterm/css/xterm.css";
  import "./terminal.css";

  import type { TerminalApi, TerminalProps } from "./terminal";
  import { extractLastUrl } from "./urls";
  import SelectionChip from "./send/SelectionChip.svelte";

  let {
    theme,
    fontFamily = "Menlo, Monaco, 'Courier New', monospace",
    fontSize = 13,
    scrollback = 10000,
    cursorBlink = true,
    paneId,
    sourceLabel,
    ondata,
    onresize,
    onready,
  }: TerminalProps = $props();

  let containerEl: HTMLDivElement | undefined = $state();
  let term: XTerm | undefined = $state();

  // Bound the backwards scan so a 100k-line scrollback doesn't pause the UI
  // thread on Cmd+Enter — recent URL emission is overwhelmingly within the
  // last screen or two anyway.
  const URL_SCAN_MAX_LINES = 1000;

  function findLastUrl(xterm: XTerm): string | undefined {
    const buf = xterm.buffer.active;
    const total = buf.length;
    if (total <= 0) return undefined;
    const minY = Math.max(0, total - URL_SCAN_MAX_LINES);
    // Walk backwards one *logical* line at a time. xterm soft-wraps a
    // long line across multiple physical rows by setting `isWrapped` on
    // every continuation row; rejoining those rows lets us recover URLs
    // that exceed the terminal's width (gh PR links, auth callbacks, the
    // `Local: http://…` line when the column is narrow) without losing
    // characters at the wrap boundary.
    let y = total - 1;
    while (y >= minY) {
      let startY = y;
      while (startY > 0) {
        const line = buf.getLine(startY);
        if (!line || !line.isWrapped) break;
        startY--;
      }
      let text = "";
      for (let k = startY; k <= y; k++) {
        text += buf.getLine(k)?.translateToString(true) ?? "";
      }
      const found = text ? extractLastUrl(text) : undefined;
      if (found) return found;
      y = startY - 1;
    }
    return undefined;
  }

  onMount(() => {
    if (!containerEl) return;

    const t = new XTerm({
      theme,
      fontFamily,
      fontSize,
      scrollback,
      cursorBlink,
      // SerializeAddon depends on proposed buffer APIs.
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const webLinks = new WebLinksAddon();
    const search = new SearchAddon();
    const serializer = new SerializeAddon();

    t.loadAddon(fit);
    t.loadAddon(webLinks);
    t.loadAddon(search);
    t.loadAddon(serializer);

    // Subscribe before opening / fitting so the resize event triggered by the
    // initial sizing is delivered to the parent.
    const dataDisposable = t.onData((d) => ondata?.(d));
    const resizeDisposable = t.onResize(({ cols, rows }) => onresize?.(cols, rows));

    t.open(containerEl);

    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        // The container can briefly report zero dimensions (e.g. when the
        // pane is hidden or while jsdom layout is unavailable in tests).
      }
    };
    safeFit();

    const observer = new ResizeObserver(() => safeFit());
    observer.observe(containerEl);

    const api: TerminalApi = {
      write: (d) => t.write(d),
      clear: () => t.clear(),
      focus: () => t.focus(),
      fit: safeFit,
      paste: (d) => t.paste(d),
      serialize: () => serializer.serialize(),
      findNext: (q) => search.findNext(q),
      findPrevious: (q) => search.findPrevious(q),
      getSelection: () => {
        const sel = t.getSelection();
        return sel.length > 0 ? sel : undefined;
      },
      findLastUrl: () => findLastUrl(t),
      get cols() {
        return t.cols;
      },
      get rows() {
        return t.rows;
      },
    };

    term = t;
    onready?.(api);

    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      t.dispose();
      term = undefined;
    };
  });

  // Reactive option updates. Each effect re-runs when the corresponding prop
  // changes; xterm's `options` setter applies the change incrementally.
  $effect(() => {
    if (term && theme !== undefined) {
      term.options.theme = theme;
    }
  });
  $effect(() => {
    if (term && fontFamily !== undefined) {
      term.options.fontFamily = fontFamily;
    }
  });
  $effect(() => {
    if (term && fontSize !== undefined) {
      term.options.fontSize = fontSize;
    }
  });
  $effect(() => {
    if (term && cursorBlink !== undefined) {
      term.options.cursorBlink = cursorBlink;
    }
  });
  $effect(() => {
    if (term && scrollback !== undefined) {
      // xterm.js supports live resizing of the scrollback buffer via the
      // `scrollback` option; shrinking drops the oldest history but the
      // current viewport is preserved.
      term.options.scrollback = scrollback;
    }
  });
</script>

<div bind:this={containerEl} class="terminal-container">
  {#if term && containerEl && paneId}
    <SelectionChip {term} container={containerEl} {paneId} sourceLabel={sourceLabel ?? paneId} />
  {/if}
</div>
