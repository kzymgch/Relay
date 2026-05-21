<script lang="ts">
  import Terminal from "$lib/Terminal.svelte";
  import type { TerminalApi } from "$lib/terminal";

  let api: TerminalApi | undefined = $state();

  function handleReady(a: TerminalApi) {
    api = a;
    a.write("Relay — terminal component ready.\r\n");
    a.write("PTY wiring lands in the next PR; keystrokes echo locally for now.\r\n\r\n");
    a.focus();
  }

  function handleData(d: string) {
    // Local echo placeholder until PR-07 wires this into the PTY bridge.
    api?.write(d);
  }
</script>

<div class="app">
  <Terminal onready={handleReady} ondata={handleData} />
</div>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    height: 100vh;
    background: #1e1e1e;
    color: #f6f6f6;
  }

  .app {
    height: 100vh;
    width: 100vw;
  }
</style>
