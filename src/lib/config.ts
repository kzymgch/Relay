// TypeScript mirror of the Rust `RelayConfig` schema in `src-tauri/src/config.rs`.
//
// Stays in lockstep with the Rust side via `#[serde(rename_all = "camelCase")]`
// on every Rust struct — these field names match the wire format byte-for-byte
// so no case mapping is needed here.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { defaultLoggingConfig, type LoggingConfig } from "./logging";

export type { LoggingConfig };

export interface FontConfig {
  family: string;
  size: number;
}

export interface ThemeConfig {
  /** `"dark"` or `"light"` — stored verbatim now, applied in a later phase. */
  mode: string;
  preset: string;
}

export interface SendConfig {
  bracketedPaste: boolean;
  trailingNewline: boolean;
}

export interface ScrollbackConfig {
  lines: number;
  /** When on, the in-memory scrollback is dumped to disk on session save. */
  persistOnExit: boolean;
  /** Per-pane byte cap for the on-disk dump (keeps the tail). */
  persistMaxBytes: number;
}

export interface SessionSettings {
  autosaveOnExit: boolean;
  restoreOnLaunch: boolean;
}

export interface SshPaneConfig {
  host: string;
  port: number | null;
  user: string | null;
  identityPath: string | null;
  sshConfigAlias: string | null;
  useKeychainPassword: boolean;
  autoReconnect: boolean;
}

export interface PaneSpecConfig {
  label: string;
  command: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  /** When present, the preset opens as an SSH remote pane. */
  ssh?: SshPaneConfig | null;
}

export interface PaneSection {
  preset: PaneSpecConfig[];
}

export interface RelayConfig {
  font: FontConfig;
  theme: ThemeConfig;
  send: SendConfig;
  scrollback: ScrollbackConfig;
  session: SessionSettings;
  logging: LoggingConfig;
  keybind: Record<string, string>;
  defaultPane: PaneSpecConfig;
  pane: PaneSection;
}

/**
 * In-process default — used when the bridge isn't available (test harness,
 * very-early startup before the first `config_load` resolves). Stays
 * structurally equal to `RelayConfig::default()` on the Rust side so a
 * roundtrip-with-no-changes never produces a diff.
 */
export function defaultConfig(): RelayConfig {
  return {
    font: { family: "Menlo", size: 13 },
    theme: { mode: "dark", preset: "default" },
    send: { bracketedPaste: true, trailingNewline: false },
    scrollback: { lines: 10_000, persistOnExit: false, persistMaxBytes: 1024 * 1024 },
    session: { autosaveOnExit: true, restoreOnLaunch: true },
    logging: defaultLoggingConfig(),
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

export const CONFIG_CHANGED_EVENT = "config:changed";

export async function loadConfig(): Promise<RelayConfig> {
  // Tests mock IPC and may return `undefined`; treat that as "no Rust side
  // available" and fall back to defaults rather than blowing up at mount.
  const raw = (await invoke("config_load")) as RelayConfig | undefined;
  return raw ?? defaultConfig();
}

export async function saveConfig(config: RelayConfig): Promise<void> {
  await invoke("config_save", { config });
}

export async function exportConfig(path: string): Promise<void> {
  await invoke("config_export", { path });
}

export async function importConfig(path: string): Promise<RelayConfig> {
  const raw = (await invoke("config_import", { path })) as RelayConfig | undefined;
  return raw ?? defaultConfig();
}

export async function onConfigChanged(handler: (cfg: RelayConfig) => void): Promise<UnlistenFn> {
  return listen<RelayConfig>(CONFIG_CHANGED_EVENT, (event) => {
    handler(event.payload);
  });
}
