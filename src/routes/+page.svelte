<script lang="ts">
  import Pane from "$lib/Pane.svelte";

  type PaneSlotId = "left" | "topRight" | "bottomRight";

  interface PaneSpec {
    id: PaneSlotId;
    label: string;
    command: string;
    args?: string[];
  }

  // PR-07 spawns the user's login shell in every slot. PR-12 will let the
  // user configure each pane's command / cwd / env, and PR-14 will load the
  // defaults from `config.toml`.
  const panes: PaneSpec[] = [
    { id: "left", label: "Pane 1", command: "/bin/zsh", args: ["-l"] },
    { id: "topRight", label: "Pane 2", command: "/bin/zsh", args: ["-l"] },
    { id: "bottomRight", label: "Pane 3", command: "/bin/zsh", args: ["-l"] },
  ];

  let focusedId: PaneSlotId = $state("left");
</script>

<div class="layout">
  {#each panes as pane (pane.id)}
    <div class="slot" style="grid-area: {pane.id};">
      <Pane
        label={pane.label}
        command={pane.command}
        args={pane.args}
        focused={focusedId === pane.id}
        onfocus={() => (focusedId = pane.id)}
      />
    </div>
  {/each}
</div>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    height: 100vh;
    width: 100vw;
    background: #000;
    color: #f6f6f6;
    overflow: hidden;
  }

  .layout {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
    grid-template-areas:
      "left topRight"
      "left bottomRight";
    height: 100vh;
    width: 100vw;
    gap: 2px;
    background: #000;
  }

  .slot {
    min-width: 0;
    min-height: 0;
  }
</style>
