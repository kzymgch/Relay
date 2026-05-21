<script lang="ts">
  import { tick } from "svelte";

  import Modal from "../Modal.svelte";
  import { fuzzyMatch } from "./fuzzy";
  import type { PaletteAction } from "./actions";

  import "./command-palette.css";

  interface Props {
    open: boolean;
    actions: PaletteAction[];
    onclose: () => void;
  }

  let { open, actions, onclose }: Props = $props();

  let query: string = $state("");
  let highlight: number = $state(0);
  let inputEl: HTMLInputElement | null = $state(null);

  // Rank actions by fuzzy score. Stable order tie-break by original index so
  // related actions stay grouped when the user hasn't typed anything yet.
  const filtered = $derived.by(() => {
    const scored: { action: PaletteAction; score: number; matched: number[]; idx: number }[] = [];
    actions.forEach((a, idx) => {
      const m = fuzzyMatch(a.label, query);
      if (!m) return;
      scored.push({ action: a, score: m.score, matched: m.matched, idx });
    });
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx;
    });
    return scored;
  });

  // Reset query + highlight whenever the palette opens; also pull focus to
  // the search input so the user can start typing immediately.
  $effect(() => {
    if (!open) return;
    query = "";
    highlight = 0;
    void tick().then(() => inputEl?.focus());
  });

  // Clamp highlight when the result set shrinks below the current index.
  $effect(() => {
    const max = filtered.length - 1;
    if (highlight > max) highlight = Math.max(0, max);
  });

  async function pick(idx: number) {
    const entry = filtered[idx];
    if (!entry) return;
    // Close BEFORE running so the action's UI side effects (e.g. opening
    // the Settings modal) don't race the palette's own teardown.
    onclose();
    await Promise.resolve(entry.action.run());
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlight = Math.min(filtered.length - 1, highlight + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlight = Math.max(0, highlight - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      void pick(highlight);
    }
  }
</script>

<Modal {open} {onclose} label="Command palette" testid="command-palette">
  <div class="palette-search">
    <input
      bind:this={inputEl}
      bind:value={query}
      {onkeydown}
      type="text"
      placeholder="Type a command…"
      data-testid="command-palette-input"
      autocomplete="off"
      spellcheck="false"
    />
  </div>
  <ul class="palette-list" data-testid="command-palette-list" role="listbox">
    {#each filtered as entry, idx (entry.action.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <li
        class="palette-row"
        class:active={idx === highlight}
        role="option"
        aria-selected={idx === highlight}
        data-testid={`command-palette-row-${entry.action.id}`}
        onmousemove={() => (highlight = idx)}
        onclick={() => pick(idx)}
      >
        <span class="row-group">{entry.action.group}</span>
        <span class="row-label">{entry.action.label}</span>
        {#if entry.action.hint}
          <span class="row-hint">{entry.action.hint}</span>
        {/if}
      </li>
    {:else}
      <li class="palette-empty">No matches</li>
    {/each}
  </ul>
</Modal>
