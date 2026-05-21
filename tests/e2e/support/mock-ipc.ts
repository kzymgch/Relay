// Inject a `window.__RELAY_MOCK_IPC__` shim that intercepts every Tauri
// `invoke` call (`window.__TAURI_INTERNALS__.invoke`) and returns canned
// responses. This runs before any page script, so AppRoot's `onMount`
// sees deterministic Rust-side state.
//
// The Tauri runtime exposes IPC via `window.__TAURI_INTERNALS__` in
// browser-mode builds; intercepting at that layer is simpler than wiring
// `@tauri-apps/api/mocks` per page because Playwright runs Vite's dev
// server directly (no real Tauri runtime present).

import type { Page } from "@playwright/test";

export interface MockIpcOptions {
  /** Pre-seed values returned by `config_load`. */
  config?: Record<string, unknown>;
  /** Sessions surfaced by `session_list` / `session_load`. */
  sessions?: Array<{ name: string; paneCount: number; data?: unknown }>;
}

export async function installMockIpc(page: Page, options: MockIpcOptions = {}): Promise<void> {
  await page.addInitScript((opts: MockIpcOptions) => {
    interface Recorded {
      cmd: string;
      args: Record<string, unknown>;
    }
    const calls: Recorded[] = [];
    const sessions = new Map<string, { paneCount: number; data?: unknown }>();
    for (const s of opts.sessions ?? []) {
      sessions.set(s.name, { paneCount: s.paneCount, data: s.data });
    }
    let currentConfig: Record<string, unknown> = opts.config ?? defaultConfig();

    function defaultConfig(): Record<string, unknown> {
      return {
        font: { family: "Menlo", size: 13 },
        theme: { preset: "dark", transparent: false, custom: null },
        send: { bracketedPaste: true, trailingNewline: false, previewBeforeSend: true },
        scrollback: { lines: 10000, persistOnExit: false, persistMaxBytes: 1048576 },
        session: { autosaveOnExit: false, restoreOnLaunch: false },
        logging: {
          enabled: false,
          dir: "",
          mode: "plain",
          maxBytes: 10485760,
          maxFiles: 5,
          dailyRotation: true,
          secrets: [],
        },
        keybind: {},
        defaultPane: {
          label: "Pane",
          command: "/bin/zsh",
          args: ["-l"],
          cwd: null,
          env: {},
        },
        pane: { preset: [] },
      };
    }

    async function handle(cmd: string, args: Record<string, unknown>): Promise<unknown> {
      calls.push({ cmd, args });
      switch (cmd) {
        case "config_load":
          return currentConfig;
        case "config_save":
          currentConfig = (args.config ?? currentConfig) as Record<string, unknown>;
          return null;
        case "config_export":
        case "config_import":
          return currentConfig;
        case "session_list":
          return Array.from(sessions.entries()).map(([name, meta]) => ({
            name,
            paneCount: meta.paneCount,
          }));
        case "session_save":
          sessions.set(args.name as string, {
            paneCount: 3,
            data: args.data,
          });
          return null;
        case "session_load": {
          const found = sessions.get(args.name as string);
          return found?.data ?? null;
        }
        case "session_delete":
          sessions.delete(args.name as string);
          return null;
        case "session_autosave_read":
        case "session_autosave_write":
        case "session_scrollback_read":
        case "session_scrollback_write":
        case "session_autosave_scrollback_read":
        case "session_autosave_scrollback_write":
        case "session_autosave_scrollback_clear":
          return null;
        case "pty_spawn":
        case "pty_write":
        case "pty_resize":
        case "pty_kill":
        case "pty_send_text":
        case "ssh_reconnect":
        case "ssh_keychain_set":
        case "ssh_keychain_delete":
          return null;
        case "log_tail":
          return { lines: [] };
        case "pipe_list":
          return [];
        case "pipe_upsert":
        case "pipe_delete":
        case "pipe_toggle":
        case "pipe_replace_all":
          return null;
        case "set_window_vibrancy":
          return null;
        default:
          return null;
      }
    }

    interface RelayWindow {
      __TAURI_INTERNALS__?: { invoke: (cmd: string, args: Record<string, unknown>) => unknown };
      __RELAY_MOCK_IPC__?: { calls: Recorded[]; setConfig: (cfg: Record<string, unknown>) => void };
    }
    const w = window as unknown as RelayWindow;
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: Record<string, unknown> = {}) => handle(cmd, args),
    };
    w.__RELAY_MOCK_IPC__ = {
      calls,
      setConfig(cfg) {
        currentConfig = cfg;
      },
    };
  }, options);
}

/** Read recorded IPC calls from the page. */
export async function recordedCalls(
  page: Page
): Promise<Array<{ cmd: string; args: Record<string, unknown> }>> {
  return page.evaluate(() => {
    interface RelayWindow {
      __RELAY_MOCK_IPC__?: { calls: Array<{ cmd: string; args: Record<string, unknown> }> };
    }
    const w = window as unknown as RelayWindow;
    return w.__RELAY_MOCK_IPC__?.calls ?? [];
  });
}
