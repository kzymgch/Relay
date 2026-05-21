<script lang="ts">
  import { tick } from "svelte";

  import Modal from "../Modal.svelte";
  import {
    defaultConfig,
    exportConfig,
    importConfig,
    type PaneSpecConfig,
    type RelayConfig,
  } from "../config";
  import type { ConfigStore } from "../config.svelte";
  import type { SettingsSection } from "../palette/actions";

  import "./settings-panel.css";

  interface Props {
    open: boolean;
    config: ConfigStore;
    onclose: () => void;
    /** Optional deep-link target from the palette's "Settings: <section>" rows. */
    initialSection?: SettingsSection | null;
  }

  let { open, config, onclose, initialSection = null }: Props = $props();

  // Draft is the form state. Initialised lazily from the live config when
  // the modal opens (via `$effect` below), so unsaved edits aren't visible
  // to the rest of the app until the user clicks Save. Seeded with the
  // built-in defaults so the form has well-formed values before the first
  // open.
  let draft: RelayConfig = $state(defaultConfig());
  // Args / env are arrays / records in the model but space-separated /
  // newline-separated strings in the form for ergonomics. Kept as separate
  // drafts so we don't have to round-trip through join/split on every
  // keystroke (which would fight the user's cursor in the textarea).
  let defaultPaneArgsRaw: string = $state("");
  let presetArgsRaw: string[] = $state([]);
  // Keybind is stored on the wire as `Record<action.id, combo>`. The form
  // edits a parallel `Array<{action, combo}>` because object keys can't
  // be reactively bound to inputs (renaming a key would lose the input
  // focus on every keystroke).
  let keybindRows: { action: string; combo: string }[] = $state([]);
  let importPath: string = $state("");
  let exportPath: string = $state("");
  let lastStatus: string = $state("");

  $effect(() => {
    if (!open) return;
    // Read all derived values from a local, non-reactive snapshot so the
    // subsequent writes to `draft` / `defaultPaneArgsRaw` / `presetArgsRaw`
    // don't create a read-after-write loop in this effect.
    // (`$state.snapshot()` strips Svelte 5's reactive proxy.)
    const snap = $state.snapshot(config.current) as RelayConfig;
    draft = snap;
    defaultPaneArgsRaw = snap.defaultPane.args.join(" ");
    presetArgsRaw = snap.pane.preset.map((p) => p.args.join(" "));
    keybindRows = Object.entries(snap.keybind).map(([action, combo]) => ({ action, combo }));
    lastStatus = "";
    if (initialSection) {
      void tick().then(() => scrollToSection(initialSection));
    }
  });

  function scrollToSection(section: SettingsSection): void {
    const id = `settings-${section}`;
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: "start", behavior: "auto" });
      // Subtle highlight so the user sees where the palette landed them.
      el.classList.add("highlight");
      setTimeout(() => el.classList.remove("highlight"), 800);
    }
  }

  function parseSpaceArgs(raw: string): string[] {
    return raw.trim() === "" ? [] : raw.trim().split(/\s+/);
  }

  function addPreset(): void {
    const next: PaneSpecConfig = {
      label: "new preset",
      command: "/bin/zsh",
      args: ["-l"],
      cwd: null,
      env: {},
    };
    draft.pane.preset = [...draft.pane.preset, next];
    presetArgsRaw = [...presetArgsRaw, next.args.join(" ")];
  }

  function removePreset(idx: number): void {
    draft.pane.preset = draft.pane.preset.filter((_, i) => i !== idx);
    presetArgsRaw = presetArgsRaw.filter((_, i) => i !== idx);
  }

  function addKeybind(): void {
    keybindRows = [...keybindRows, { action: "", combo: "" }];
  }

  function removeKeybind(idx: number): void {
    keybindRows = keybindRows.filter((_, i) => i !== idx);
  }

  /** Collapse the form rows into the `Record<action, combo>` shape. The
   * last row wins when duplicate action keys exist; empty actions are
   * dropped. */
  function keybindMap(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const { action, combo } of keybindRows) {
      const a = action.trim();
      if (!a) continue;
      out[a] = combo.trim();
    }
    return out;
  }

  async function save(): Promise<void> {
    try {
      // Re-derive args + keybind map from the form mirrors just before
      // persisting so the user's edits inside the input fields make it
      // onto the wire.
      draft.defaultPane.args = parseSpaceArgs(defaultPaneArgsRaw);
      draft.pane.preset = draft.pane.preset.map((p, i) => ({
        ...p,
        args: parseSpaceArgs(presetArgsRaw[i] ?? ""),
      }));
      draft.keybind = keybindMap();
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
      // Re-seed the form mirrors from the imported config too — otherwise
      // the next Save would re-derive args / keybind from the stale form
      // values and silently overwrite what was just imported.
      defaultPaneArgsRaw = next.defaultPane.args.join(" ");
      presetArgsRaw = next.pane.preset.map((p) => p.args.join(" "));
      keybindRows = Object.entries(next.keybind).map(([action, combo]) => ({ action, combo }));
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
      <label for="settings-default-args">Args</label>
      <input
        id="settings-default-args"
        type="text"
        placeholder="space-separated"
        bind:value={defaultPaneArgsRaw}
        data-testid="settings-default-args"
      />
      <label for="settings-default-cwd">cwd</label>
      <input
        id="settings-default-cwd"
        type="text"
        placeholder="(inherit)"
        value={draft.defaultPane.cwd ?? ""}
        oninput={(e) => {
          const v = (e.currentTarget as HTMLInputElement).value;
          draft.defaultPane.cwd = v.trim() === "" ? null : v;
        }}
        data-testid="settings-default-cwd"
      />
    </section>

    <section class="settings-section settings-presets" data-testid="settings-pane-presets">
      <h3>Pane presets</h3>
      <span class="settings-readonly settings-presets-help">
        Entries surfaced as "Add pane: &lt;label&gt;" in the command palette.
      </span>
      {#each draft.pane.preset as preset, idx (idx)}
        <div class="settings-preset-row" data-testid={`settings-pane-preset-${idx}`}>
          <input
            type="text"
            placeholder="label"
            bind:value={preset.label}
            data-testid={`settings-pane-preset-label-${idx}`}
          />
          <input
            type="text"
            placeholder="command"
            bind:value={preset.command}
            data-testid={`settings-pane-preset-command-${idx}`}
          />
          <input
            type="text"
            placeholder="args (space-sep)"
            bind:value={presetArgsRaw[idx]}
            data-testid={`settings-pane-preset-args-${idx}`}
          />
          <input
            type="text"
            placeholder="cwd"
            value={preset.cwd ?? ""}
            oninput={(e) => {
              const v = (e.currentTarget as HTMLInputElement).value;
              preset.cwd = v.trim() === "" ? null : v;
            }}
            data-testid={`settings-pane-preset-cwd-${idx}`}
          />
          <button
            type="button"
            class="settings-preset-remove"
            onclick={() => removePreset(idx)}
            data-testid={`settings-pane-preset-remove-${idx}`}
            aria-label="Remove preset"
          >
            ×
          </button>
        </div>
      {/each}
      <button
        type="button"
        class="settings-preset-add"
        onclick={addPreset}
        data-testid="settings-pane-preset-add"
      >
        + Add preset
      </button>
    </section>

    <section class="settings-section" data-testid="settings-theme">
      <h3>Theme</h3>
      <label for="settings-theme-mode">Mode</label>
      <select
        id="settings-theme-mode"
        bind:value={draft.theme.mode}
        data-testid="settings-theme-mode"
      >
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
      <label for="settings-theme-preset">Preset</label>
      <input
        id="settings-theme-preset"
        type="text"
        placeholder="default"
        bind:value={draft.theme.preset}
        data-testid="settings-theme-preset"
      />
    </section>

    <section class="settings-section settings-keybind" data-testid="settings-keybind">
      <h3>Keybindings</h3>
      <span class="settings-readonly settings-keybind-help">
        Stored under <code>[keybind]</code> in config.toml. Combos (e.g.
        <code>cmd+p</code>) round-trip through save / import but are not yet re-dispatched at
        runtime — that ships with the full keybind system.
      </span>
      {#each keybindRows as row, idx (idx)}
        <div class="settings-keybind-row" data-testid={`settings-keybind-row-${idx}`}>
          <input
            type="text"
            placeholder="action.id (e.g. palette.open)"
            bind:value={row.action}
            data-testid={`settings-keybind-action-${idx}`}
          />
          <input
            type="text"
            placeholder="combo (e.g. cmd+p)"
            bind:value={row.combo}
            data-testid={`settings-keybind-combo-${idx}`}
          />
          <button
            type="button"
            class="settings-preset-remove"
            onclick={() => removeKeybind(idx)}
            data-testid={`settings-keybind-remove-${idx}`}
            aria-label="Remove keybinding"
          >
            ×
          </button>
        </div>
      {/each}
      <button
        type="button"
        class="settings-preset-add"
        onclick={addKeybind}
        data-testid="settings-keybind-add"
      >
        + Add binding
      </button>
    </section>

    <section class="settings-section" data-testid="settings-logging">
      <h3>Logging</h3>
      <label for="settings-logging-enabled">Enabled</label>
      <input
        id="settings-logging-enabled"
        type="checkbox"
        bind:checked={draft.logging.enabled}
        data-testid="settings-logging-enabled"
      />
      <label for="settings-logging-mode">Mode</label>
      <select
        id="settings-logging-mode"
        bind:value={draft.logging.mode}
        data-testid="settings-logging-mode"
      >
        <option value="plain">Plain (ANSI stripped, secrets masked)</option>
        <option value="raw">Raw (bytes verbatim)</option>
      </select>
      <label for="settings-logging-dir">Directory</label>
      <input
        id="settings-logging-dir"
        type="text"
        placeholder="(default: ~/.config/relay/logs)"
        bind:value={draft.logging.dir}
        data-testid="settings-logging-dir"
      />
      <label for="settings-logging-max-bytes">Max bytes per file</label>
      <input
        id="settings-logging-max-bytes"
        type="number"
        min="0"
        bind:value={draft.logging.maxBytes}
        data-testid="settings-logging-max-bytes"
      />
      <label for="settings-logging-max-files">Max rotated files</label>
      <input
        id="settings-logging-max-files"
        type="number"
        min="0"
        bind:value={draft.logging.maxFiles}
        data-testid="settings-logging-max-files"
      />
      <label for="settings-logging-daily">Daily rotation</label>
      <input
        id="settings-logging-daily"
        type="checkbox"
        bind:checked={draft.logging.dailyRotation}
        data-testid="settings-logging-daily"
      />
      <label for="settings-logging-secrets">Secret regexes (one per line)</label>
      <textarea
        id="settings-logging-secrets"
        rows="3"
        value={draft.logging.secrets.join("\n")}
        oninput={(e) => {
          const raw = (e.currentTarget as HTMLTextAreaElement).value;
          draft.logging.secrets = raw
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        }}
        data-testid="settings-logging-secrets"
      ></textarea>
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
