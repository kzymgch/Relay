<script lang="ts">
  import Modal from "../Modal.svelte";
  import { defaultConfig, exportConfig, importConfig, type RelayConfig } from "../config";
  import type { ConfigStore } from "../config.svelte";

  import "./settings-panel.css";

  interface Props {
    open: boolean;
    config: ConfigStore;
    onclose: () => void;
  }

  let { open, config, onclose }: Props = $props();

  // Draft is the form state. Initialised lazily from the live config when
  // the modal opens (via `$effect` below), so unsaved edits aren't visible
  // to the rest of the app until the user clicks Save. Seeded with the
  // built-in defaults so the form has well-formed values before the first
  // open.
  let draft: RelayConfig = $state(defaultConfig());
  let importPath: string = $state("");
  let exportPath: string = $state("");
  let lastStatus: string = $state("");

  $effect(() => {
    if (open) {
      // `$state.snapshot()` strips Svelte 5's reactive proxy so the result
      // is a plain object — needed because `structuredClone` chokes on the
      // proxy and because the draft is intentionally a *detached* copy.
      draft = $state.snapshot(config.current) as RelayConfig;
      lastStatus = "";
    }
  });

  async function save(): Promise<void> {
    try {
      await config.set(draft);
      lastStatus = "Saved.";
    } catch (e) {
      lastStatus = `Save failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function onExport(): Promise<void> {
    const path = exportPath.trim();
    if (!path) {
      lastStatus = "Enter an export path.";
      return;
    }
    try {
      await exportConfig(path);
      lastStatus = `Exported to ${path}`;
    } catch (e) {
      lastStatus = `Export failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function onImport(): Promise<void> {
    const path = importPath.trim();
    if (!path) {
      lastStatus = "Enter an import path.";
      return;
    }
    try {
      const next = await importConfig(path);
      // Mirror the imported config into the live store so the rest of the
      // app picks it up immediately; the Rust side has already persisted to
      // the canonical config.toml.
      await config.set(next);
      draft = next;
      lastStatus = `Imported from ${path}`;
    } catch (e) {
      lastStatus = `Import failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
</script>

<Modal {open} {onclose} label="Settings" testid="settings-panel">
  <div class="settings-header">
    <h2>Settings</h2>
    <span class="settings-readonly">~/.config/relay/config.toml</span>
  </div>
  <div class="settings-body">
    <section class="settings-section" data-testid="settings-font">
      <h3>Font</h3>
      <label for="settings-font-family">Family</label>
      <input
        id="settings-font-family"
        type="text"
        bind:value={draft.font.family}
        data-testid="settings-font-family"
      />
      <label for="settings-font-size">Size</label>
      <input
        id="settings-font-size"
        type="number"
        min="8"
        max="32"
        bind:value={draft.font.size}
        data-testid="settings-font-size"
      />
    </section>

    <section class="settings-section" data-testid="settings-send">
      <h3>Send options</h3>
      <label for="settings-send-bracketed">Bracketed paste</label>
      <input
        id="settings-send-bracketed"
        type="checkbox"
        bind:checked={draft.send.bracketedPaste}
        data-testid="settings-send-bracketed"
      />
      <label for="settings-send-newline">Trailing newline</label>
      <input
        id="settings-send-newline"
        type="checkbox"
        bind:checked={draft.send.trailingNewline}
        data-testid="settings-send-newline"
      />
    </section>

    <section class="settings-section" data-testid="settings-scrollback">
      <h3>Scrollback</h3>
      <label for="settings-scrollback-lines">Lines</label>
      <input
        id="settings-scrollback-lines"
        type="number"
        min="100"
        bind:value={draft.scrollback.lines}
        data-testid="settings-scrollback-lines"
      />
      <label for="settings-scrollback-persist">Persist on exit</label>
      <input
        id="settings-scrollback-persist"
        type="checkbox"
        bind:checked={draft.scrollback.persistOnExit}
        data-testid="settings-scrollback-persist"
      />
      <label for="settings-scrollback-cap">Cap (bytes / pane)</label>
      <input
        id="settings-scrollback-cap"
        type="number"
        min="0"
        bind:value={draft.scrollback.persistMaxBytes}
        data-testid="settings-scrollback-cap"
      />
    </section>

    <section class="settings-section" data-testid="settings-session">
      <h3>Session</h3>
      <label for="settings-session-autosave">Autosave on exit</label>
      <input
        id="settings-session-autosave"
        type="checkbox"
        bind:checked={draft.session.autosaveOnExit}
        data-testid="settings-session-autosave"
      />
      <label for="settings-session-restore">Restore on launch</label>
      <input
        id="settings-session-restore"
        type="checkbox"
        bind:checked={draft.session.restoreOnLaunch}
        data-testid="settings-session-restore"
      />
    </section>

    <section class="settings-section" data-testid="settings-default-pane">
      <h3>Default pane</h3>
      <label for="settings-default-label">Label</label>
      <input
        id="settings-default-label"
        type="text"
        bind:value={draft.defaultPane.label}
        data-testid="settings-default-label"
      />
      <label for="settings-default-command">Command</label>
      <input
        id="settings-default-command"
        type="text"
        bind:value={draft.defaultPane.command}
        data-testid="settings-default-command"
      />
    </section>

    <section class="settings-section" data-testid="settings-theme">
      <h3>Theme</h3>
      <span class="settings-readonly">Mode</span>
      <span class="settings-readonly">{draft.theme.mode} (editor lands in a later phase)</span>
      <span class="settings-readonly">Preset</span>
      <span class="settings-readonly">{draft.theme.preset}</span>
    </section>

    <section class="settings-section" data-testid="settings-keybind">
      <h3>Keybindings</h3>
      <span class="settings-readonly">Status</span>
      <span class="settings-readonly">
        {Object.keys(draft.keybind).length} custom binding{Object.keys(draft.keybind).length === 1
          ? ""
          : "s"} — editor lands in a later phase
      </span>
    </section>

    <section class="settings-section" data-testid="settings-import-export">
      <h3>Import / Export</h3>
      <label for="settings-export-path">Export to</label>
      <input
        id="settings-export-path"
        type="text"
        placeholder="/path/to/file.toml"
        bind:value={exportPath}
        data-testid="settings-export-path"
      />
      <label for="settings-import-path">Import from</label>
      <input
        id="settings-import-path"
        type="text"
        placeholder="/path/to/file.toml"
        bind:value={importPath}
        data-testid="settings-import-path"
      />
    </section>

    {#if lastStatus}
      <div data-testid="settings-status">{lastStatus}</div>
    {/if}
  </div>

  <div class="settings-footer">
    <button type="button" data-testid="settings-import" onclick={onImport}>Import</button>
    <button type="button" data-testid="settings-export" onclick={onExport}>Export</button>
    <button type="button" data-testid="settings-cancel" onclick={onclose}>Cancel</button>
    <button type="button" class="primary" data-testid="settings-save" onclick={save}>Save</button>
  </div>
</Modal>
