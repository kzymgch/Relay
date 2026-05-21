// Per-pane file logging (spec §11) — TS bindings.
//
// The actual writing happens in `src-tauri/src/log.rs`; this module exposes
// just the tail-reader command. Logging configuration lives inside
// `RelayConfig.logging` and is round-tripped through the same save/load
// machinery as the rest of the config.

import { invoke } from "@tauri-apps/api/core";

export interface LoggingConfig {
  enabled: boolean;
  /** Absolute path. Empty string means "use the default `~/.config/relay/logs/`". */
  dir: string;
  /** `"raw"` keeps ANSI bytes; `"plain"` strips ANSI and applies secret masks. */
  mode: string;
  /** Rotate when file grows past this. `0` disables size rotation. */
  maxBytes: number;
  /** Keep at most this many rotated backups per pane. */
  maxFiles: number;
  /** Roll a fresh file when the local date changes. */
  dailyRotation: boolean;
  /** Regex sources applied per-line in plain mode. Matches → `***`. */
  secrets: string[];
}

export function defaultLoggingConfig(): LoggingConfig {
  return {
    enabled: false,
    dir: "",
    mode: "plain",
    maxBytes: 10 * 1024 * 1024,
    maxFiles: 5,
    dailyRotation: true,
    secrets: [],
  };
}

/**
 * Read up to `maxBytes` from the tail of the current log file for `paneId`.
 * Returns an empty array when the file doesn't exist yet.
 */
export async function logTail(paneId: string, maxBytes: number): Promise<Uint8Array> {
  const raw = (await invoke("log_tail", { paneId, maxBytes })) as number[] | undefined;
  return new Uint8Array(raw ?? []);
}
