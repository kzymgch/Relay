import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PaneId = string;

export interface SshSpawnConfig {
  host: string;
  port?: number;
  user?: string;
  identityPath?: string;
  sshConfigAlias?: string;
  /** When true, the backend looks up the password by `<user>@<host>` in the
   *  macOS Keychain (service `relay-ssh`). Plaintext passwords never traverse
   *  this IPC boundary. */
  useKeychainPassword?: boolean;
  /** Default: `true`. When `false`, an unexpected disconnect surfaces as
   *  `pty:exit` instead of triggering the supervisor's backoff loop. */
  autoReconnect?: boolean;
}

export interface PtySpawnConfig {
  /**
   * JS-allocated pane id. The frontend subscribes to `pty:data` / `pty:exit`
   * with this id *before* invoking spawn so events emitted in the gap
   * between the bridge starting its forward task and the spawn IPC
   * returning are routed correctly. The backend rejects duplicate ids.
   */
  id: PaneId;
  /** Local command. Required for local panes; ignored when `ssh` is set. */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** When present, the backend opens an SSH session against the remote and
   *  streams its login shell through the same `pty:data` / `pty:exit` events
   *  used for local PTYs. */
  ssh?: SshSpawnConfig;
}

export interface PtyDataPayload {
  paneId: PaneId;
  data: number[];
}

export interface PtyExitPayload {
  paneId: PaneId;
  code: number;
  success: boolean;
}

export const PTY_DATA_EVENT = "pty:data";
export const PTY_EXIT_EVENT = "pty:exit";

export async function spawnPty(config: PtySpawnConfig): Promise<void> {
  await invoke("pty_spawn", { config });
}

export async function writePty(id: PaneId, data: Uint8Array): Promise<void> {
  await invoke("pty_write", { id, data: Array.from(data) });
}

export async function resizePty(id: PaneId, cols: number, rows: number): Promise<void> {
  await invoke("pty_resize", { id, cols, rows });
}

export async function killPty(id: PaneId): Promise<void> {
  await invoke("pty_kill", { id });
}

/**
 * Send text to a pane's PTY with bracketed-paste framing and an optional
 * trailing newline. The Rust side builds the wire payload (`build_send_payload`
 * in `bridge.rs`) so the wrapping policy stays in one place and is
 * Rust-tested.
 */
export async function sendPtyText(
  id: PaneId,
  text: string,
  bracketedPaste: boolean,
  trailingNewline: boolean
): Promise<void> {
  await invoke("pty_send_text", {
    id,
    text,
    bracketedPaste,
    trailingNewline,
  });
}

/** Convert the on-the-wire `pty:data` payload into a typed view. */
export function parsePtyData(payload: PtyDataPayload): { paneId: PaneId; data: Uint8Array } {
  return { paneId: payload.paneId, data: new Uint8Array(payload.data) };
}

export async function onPtyData(
  handler: (paneId: PaneId, data: Uint8Array) => void
): Promise<UnlistenFn> {
  return listen<PtyDataPayload>(PTY_DATA_EVENT, (event) => {
    const parsed = parsePtyData(event.payload);
    handler(parsed.paneId, parsed.data);
  });
}

export async function onPtyExit(
  handler: (paneId: PaneId, code: number, success: boolean) => void
): Promise<UnlistenFn> {
  return listen<PtyExitPayload>(PTY_EXIT_EVENT, (event) => {
    handler(event.payload.paneId, event.payload.code, event.payload.success);
  });
}
