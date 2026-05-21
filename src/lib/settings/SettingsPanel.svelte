<script lang="ts">
  import { tick } from "svelte";

  import Modal from "../Modal.svelte";
  import {
    defaultConfig,
    exportConfig,
    importConfig,
    type CustomThemePayload,
    type PaneSpecConfig,
    type RelayConfig,
  } from "../config";
  import type { ConfigStore } from "../config.svelte";
  import type { SettingsSection } from "../palette/actions";
  import { BUILTIN_THEMES, BUILTIN_THEME_IDS, type ThemeId } from "../theme/presets";
  import { KEYBIND_ACTIONS, defaultKeybindMap } from "../keybind/actions";
  import { comboFromEvent, formatCombo, parseCombo } from "../keybind/combo";
  import { resolveKeybinds } from "../keybind/resolve";
  import { detectConflicts } from "../keybind/conflicts";

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
  // Per-action combo state — one entry per `KEYBIND_ACTIONS` row. Initial
  // values are populated from `config.keybind`, falling back to the default
  // combo when the user hasn't overridden it.
  let keybindCombos: Record<string, string> = $state({});
  let recordingAction: string | null = $state(null);
  // Slot ids → "#rrggbb" for the customisable colour pickers. Mirrors
  // `draft.theme.custom` but in a flat shape that's easier to bind to
  // <input type="color">.
  let customColours: Record<string, string> = $state({});
  let importPath: string = $state("");
  let exportPath: string = $state("");
  let lastStatus: string = $state("");

  $effect(() => {
    if (!open) {
      // Closing the panel must also disarm any pending Record listener —
      // otherwise the next keystroke in the underlying terminal would
      // commit a stray combo to the action that was being recorded.
      cancelRecording?.();
      return;
    }
    // Read all derived values from a local, non-reactive snapshot so the
    // subsequent writes to `draft` / `defaultPaneArgsRaw` / `presetArgsRaw`
    // don't create a read-after-write loop in this effect.
    // (`$state.snapshot()` strips Svelte 5's reactive proxy.)
    const snap = $state.snapshot(config.current) as RelayConfig;
    draft = snap;
    defaultPaneArgsRaw = snap.defaultPane.args.join(" ");
    presetArgsRaw = snap.pane.preset.map((p) => p.args.join(" "));
    keybindCombos = seedKeybindCombos(snap.keybind);
    customColours = seedCustomColours(snap.theme.custom);
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

  function seedKeybindCombos(userMap: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const action of KEYBIND_ACTIONS) {
      const override = userMap[action.id];
      out[action.id] = override ?? action.defaultCombo;
    }
    return out;
  }

  /** Strip rows whose combo equals the default — those don't need to land in
   *  config.keybind, and skipping them keeps the on-disk diff minimal when
   *  the user only tweaked one or two bindings. */
  function keybindOverridesForSave(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const action of KEYBIND_ACTIONS) {
      const cur = keybindCombos[action.id] ?? action.defaultCombo;
      if (cur !== action.defaultCombo) {
        out[action.id] = cur;
      }
    }
    return out;
  }

  /** Cleanup hook for the currently-armed recording listener. `null` when
   *  no Record button is waiting for input. Held in module scope so a
   *  second Record click can tear down the previous arm, and so closing
   *  the modal (the $effect below) doesn't leak a dangling listener. */
  let cancelRecording: (() => void) | null = null;

  /** Begin recording: the next non-modifier keydown over the row commits a
   *  fresh combo. The handler attaches a one-shot window listener so the
   *  capture works no matter which element happens to be focused. Clicking
   *  Record on a second row first cancels the previous arm — otherwise the
   *  next keypress would commit to both rows. */
  function startRecording(actionId: string): void {
    cancelRecording?.();
    recordingAction = actionId;
    const listener = (event: KeyboardEvent) => {
      const combo = comboFromEvent(event);
      if (!combo) return; // ignore lone modifier presses
      event.preventDefault();
      event.stopPropagation();
      keybindCombos = { ...keybindCombos, [actionId]: formatCombo(combo) };
      teardown();
    };
    const teardown = (): void => {
      window.removeEventListener("keydown", listener, true);
      cancelRecording = null;
      recordingAction = null;
    };
    cancelRecording = teardown;
    window.addEventListener("keydown", listener, true);
  }

  function resetKeybind(actionId: string): void {
    const def = KEYBIND_ACTIONS.find((a) => a.id === actionId);
    if (!def) return;
    cancelRecording?.();
    keybindCombos = { ...keybindCombos, [actionId]: def.defaultCombo };
  }

  function resetAllKeybinds(): void {
    cancelRecording?.();
    keybindCombos = defaultKeybindMap();
  }

  function seedCustomColours(
    custom: CustomThemePayload | null | undefined
  ): Record<string, string> {
    const out: Record<string, string> = {};
    if (custom) {
      for (const [slot, value] of Object.entries(custom.xterm ?? {})) {
        out[`xterm.${slot}`] = value;
      }
      for (const [slot, value] of Object.entries(custom.chrome ?? {})) {
        out[`chrome.${slot}`] = value;
      }
    }
    return out;
  }

  /** Convert the flat `customColours` map back into the structured payload
   *  required by `ThemeConfig.custom`. Only emits slots the user touched.
   *
   *  Always returns an object (possibly empty) because Rust validation
   *  requires `theme.custom` to be `Some` when `theme.preset == "custom"`.
   *  An empty payload means "fall back to FALLBACK_THEME everywhere",
   *  which the resolver already handles. */
  function buildCustomPayload(): CustomThemePayload {
    const xterm: Record<string, string> = {};
    const chrome: Record<string, string> = {};
    for (const [key, value] of Object.entries(customColours)) {
      if (!value) continue;
      if (key.startsWith("xterm.")) {
        xterm[key.slice("xterm.".length)] = value;
      } else if (key.startsWith("chrome.")) {
        chrome[key.slice("chrome.".length)] = value;
      }
    }
    return { xterm, chrome };
  }

  /** Customisable slots surfaced in the GUI. Keep the list short: the modal
   *  is already busy and the long tail (16 ANSI variants × chrome) is better
   *  edited by hand in config.toml. */
  const CUSTOM_XTERM_SLOTS: readonly { key: string; label: string }[] = [
    { key: "background", label: "Terminal background" },
    { key: "foreground", label: "Terminal foreground" },
    { key: "cursor", label: "Cursor" },
    { key: "selectionBackground", label: "Selection" },
  ];
  const CUSTOM_CHROME_SLOTS: readonly { key: string; label: string }[] = [
    { key: "appBg", label: "App background" },
    { key: "toolbarBg", label: "Toolbar" },
    { key: "paneBorderFocused", label: "Focused pane border" },
    { key: "modalBg", label: "Modal background" },
  ];

  /** Conflict report computed against the form's current combo selection.
   *  Shown as a red banner inside the keybind section. */
  const keybindConflicts = $derived.by(() => {
    const overrides: Record<string, string> = {};
    for (const action of KEYBIND_ACTIONS) {
      const cur = keybindCombos[action.id];
      if (cur && cur !== action.defaultCombo) overrides[action.id] = cur;
    }
    return detectConflicts(resolveKeybinds(overrides));
  });

  function comboDisplay(actionId: string): string {
    const cur = keybindCombos[actionId];
    if (!cur) return "";
    const parsed = parseCombo(cur);
    return parsed ? formatCombo(parsed) : cur;
  }

  function isInvalidCombo(actionId: string): boolean {
    const cur = keybindCombos[actionId];
    if (!cur) return false;
    return parseCombo(cur) === null;
  }

  function actionLabel(actionId: string): string {
    return KEYBIND_ACTIONS.find((a) => a.id === actionId)?.label ?? actionId;
  }

  function presetLabel(id: string): string {
    if (id === "custom") return "Custom";
    return BUILTIN_THEMES[id as ThemeId]?.label ?? id;
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
      draft.keybind = keybindOverridesForSave();
      draft.theme.custom = draft.theme.preset === "custom" ? buildCustomPayload() : null;
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
      keybindCombos = seedKeybindCombos(next.keybind);
      customColours = seedCustomColours(next.theme.custom);
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
      <label for="settings-send-preview">Preview before send</label>
      <input
        id="settings-send-preview"
        type="checkbox"
        bind:checked={draft.send.previewBeforeSend}
        data-testid="settings-send-preview"
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
          <label class="settings-preset-kind">
            <input
              type="checkbox"
              checked={preset.ssh != null}
              onchange={(e) => {
                const on = (e.currentTarget as HTMLInputElement).checked;
                preset.ssh = on
                  ? {
                      host: "",
                      port: null,
                      user: null,
                      identityPath: null,
                      sshConfigAlias: null,
                      useKeychainPassword: false,
                      autoReconnect: true,
                    }
                  : null;
              }}
              data-testid={`settings-pane-preset-ssh-toggle-${idx}`}
            />
            SSH
          </label>
          {#if preset.ssh}
            <input
              type="text"
              placeholder="ssh host"
              bind:value={preset.ssh.host}
              data-testid={`settings-pane-preset-ssh-host-${idx}`}
            />
            <input
              type="text"
              placeholder="ssh_config alias (optional)"
              value={preset.ssh.sshConfigAlias ?? ""}
              oninput={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value;
                if (preset.ssh) preset.ssh.sshConfigAlias = v.trim() === "" ? null : v;
              }}
              data-testid={`settings-pane-preset-ssh-alias-${idx}`}
            />
            <input
              type="text"
              placeholder="user (optional)"
              value={preset.ssh.user ?? ""}
              oninput={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value;
                if (preset.ssh) preset.ssh.user = v.trim() === "" ? null : v;
              }}
              data-testid={`settings-pane-preset-ssh-user-${idx}`}
            />
          {:else}
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
          {/if}
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
      <label for="settings-theme-preset">Preset</label>
      <select
        id="settings-theme-preset"
        bind:value={draft.theme.preset}
        data-testid="settings-theme-preset"
      >
        {#each BUILTIN_THEME_IDS as id (id)}
          <option value={id}>{presetLabel(id)}</option>
        {/each}
        <option value="custom">Custom</option>
      </select>
      <label for="settings-theme-transparent">Transparent (macOS vibrancy)</label>
      <input
        id="settings-theme-transparent"
        type="checkbox"
        bind:checked={draft.theme.transparent}
        data-testid="settings-theme-transparent"
      />
      {#if draft.theme.preset === "custom"}
        <div class="settings-theme-custom" data-testid="settings-theme-custom">
          {#each CUSTOM_XTERM_SLOTS as slot (slot.key)}
            <label for={`settings-theme-xterm-${slot.key}`}>{slot.label}</label>
            <input
              id={`settings-theme-xterm-${slot.key}`}
              type="color"
              value={customColours[`xterm.${slot.key}`] ?? "#000000"}
              oninput={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value;
                customColours = { ...customColours, [`xterm.${slot.key}`]: v };
              }}
              data-testid={`settings-theme-xterm-${slot.key}`}
            />
          {/each}
          {#each CUSTOM_CHROME_SLOTS as slot (slot.key)}
            <label for={`settings-theme-chrome-${slot.key}`}>{slot.label}</label>
            <input
              id={`settings-theme-chrome-${slot.key}`}
              type="color"
              value={customColours[`chrome.${slot.key}`] ?? "#000000"}
              oninput={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value;
                customColours = { ...customColours, [`chrome.${slot.key}`]: v };
              }}
              data-testid={`settings-theme-chrome-${slot.key}`}
            />
          {/each}
        </div>
      {/if}
    </section>

    <section class="settings-section settings-keybind" data-testid="settings-keybind">
      <h3>Keybindings</h3>
      <span class="settings-readonly settings-keybind-help">
        Click <strong>Record</strong> on a row, then press the combo you want. Press
        <strong>Reset</strong> to fall back to the default.
      </span>
      {#if keybindConflicts.length > 0}
        <div class="settings-keybind-conflicts" data-testid="settings-keybind-conflicts">
          {#each keybindConflicts as conflict (conflict.combo)}
            <div>
              <code>{conflict.combo}</code> is bound to multiple actions:
              {conflict.actionIds.map((id) => actionLabel(id)).join(", ")}
            </div>
          {/each}
        </div>
      {/if}
      {#each KEYBIND_ACTIONS as action (action.id)}
        <div class="settings-keybind-row" data-testid={`settings-keybind-row-${action.id}`}>
          <span>{action.label}</span>
          <span
            class="combo"
            class:empty={!keybindCombos[action.id]}
            class:recording={recordingAction === action.id}
            class:invalid={isInvalidCombo(action.id)}
            data-testid={`settings-keybind-combo-${action.id}`}
          >
            {#if recordingAction === action.id}
              press a key…
            {:else}
              {comboDisplay(action.id) || action.defaultCombo}
            {/if}
          </span>
          <button
            type="button"
            onclick={() => startRecording(action.id)}
            data-testid={`settings-keybind-record-${action.id}`}
          >
            Record
          </button>
          <button
            type="button"
            onclick={() => resetKeybind(action.id)}
            data-testid={`settings-keybind-reset-${action.id}`}
          >
            Reset
          </button>
        </div>
      {/each}
      <button
        type="button"
        class="settings-keybind-reset-all"
        onclick={resetAllKeybinds}
        data-testid="settings-keybind-reset-all"
      >
        Reset all to defaults
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
