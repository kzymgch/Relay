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

  let {
    theme,
    fontFamily = "Menlo, Monaco, 'Courier New', monospace",
    fontSize = 13,
    scrollback = 10000,
    cursorBlink = true,
    ondata,
    onresize,
    onready,
  }: TerminalProps = $props();

  let containerEl: HTMLDivElement | undefined = $state();

  onMount(() => {
    if (!containerEl) return;

    const term = new XTerm({
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

    term.loadAddon(fit);
    term.loadAddon(webLinks);
    term.loadAddon(search);
    term.loadAddon(serializer);

    term.open(containerEl);

    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        // The container can briefly report zero dimensions (e.g. when the
        // pane is hidden or while jsdom layout is unavailable in tests).
      }
    };
    safeFit();

    const dataDisposable = term.onData((d) => ondata?.(d));
    const resizeDisposable = term.onResize(({ cols, rows }) => onresize?.(cols, rows));

    const observer = new ResizeObserver(() => safeFit());
    observer.observe(containerEl);

    const api: TerminalApi = {
      write: (d) => term.write(d),
      clear: () => term.clear(),
      focus: () => term.focus(),
      fit: safeFit,
      paste: (d) => term.paste(d),
      serialize: () => serializer.serialize(),
      findNext: (q) => search.findNext(q),
      findPrevious: (q) => search.findPrevious(q),
      get cols() {
        return term.cols;
      },
      get rows() {
        return term.rows;
      },
    };

    onready?.(api);

    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      term.dispose();
    };
  });
</script>

<div bind:this={containerEl} class="terminal-container"></div>
