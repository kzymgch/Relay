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
