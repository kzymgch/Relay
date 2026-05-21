import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { PaneId } from "./pty";

export type SshStatus = "connecting" | "connected" | "disconnected" | "reconnecting";

export interface SshStatusPayload {
  paneId: PaneId;
  status: SshStatus;
  /** 0 on the initial connect; 1-based once the reconnect supervisor takes over. */
  attempt: number;
  /** Optional human-readable detail (currently always null; reserved). */
  message: string | null;
}

export interface SshHostAlias {
  alias: string;
}

export const SSH_STATUS_EVENT = "ssh:status";

/** Force an SSH pane to retry its current reconnect cycle immediately,
 *  bypassing the backoff sleep. No-op if the pane is currently connected
 *  (the next disconnect will still notice the signal). */
export async function sshReconnect(id: PaneId): Promise<void> {
  await invoke("ssh_reconnect", { id });
}

/** Aliases pulled from `~/.ssh/config` for the settings GUI dropdown. */
export async function sshConfigHosts(): Promise<SshHostAlias[]> {
  return await invoke<SshHostAlias[]>("ssh_config_hosts");
}

/** Store an SSH password / key passphrase in the Relay Keychain entry.
 *  The plaintext lives only on the Rust side after this call returns; the
 *  frontend can subsequently check `sshKeychainHas` but cannot read back. */
export async function sshKeychainSet(user: string, host: string, password: string): Promise<void> {
  await invoke("ssh_keychain_set", { user, host, password });
}

export async function sshKeychainHas(user: string, host: string): Promise<boolean> {
  return await invoke<boolean>("ssh_keychain_has", { user, host });
}

export async function sshKeychainDelete(user: string, host: string): Promise<void> {
  await invoke("ssh_keychain_delete", { user, host });
}

export async function onSshStatus(
  handler: (payload: SshStatusPayload) => void
): Promise<UnlistenFn> {
  return listen<SshStatusPayload>(SSH_STATUS_EVENT, (event) => handler(event.payload));
}
