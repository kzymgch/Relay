// Session save / load / autosave bridge.
//
// The on-wire shape mirrors `SessionData` in `src-tauri/src/session.rs`:
// `layout` is opaque JSON to Rust, so we put the layout-snapshot dictionary
// straight in there. Old session files (without `rules`) still deserialize
// because both sides default-fill the field.

import { invoke } from "@tauri-apps/api/core";

import type { LayoutSnapshot } from "./layout/tree";
import { pipeReplaceAll, type PipeRule } from "./pipe";
import type { SendOptions } from "./send";

export interface LayoutPayload {
  tree: LayoutSnapshot["tree"];
  panes: LayoutSnapshot["panes"];
  focusedPaneId: LayoutSnapshot["focusedPaneId"];
  /** Names → snapshots for in-memory custom layouts. */
  customLayouts: Record<string, LayoutSnapshot>;
}

export interface SessionData {
  layout: LayoutPayload;
  sendOptions: SendOptions | null;
  /** Pipe rules captured at save time. Restored into the Rust dispatcher
   * via `pipeReplaceAll` when the session loads. */
  rules: PipeRule[];
  /** Names of panes whose scrollback was dumped to disk for this session. */
  scrollbackKeys: string[];
  savedAt: string;
  name: string;
}

export interface SessionMetadata {
  name: string;
  savedAt: string;
  paneCount: number;
}

export interface LayoutSourceForSave {
  tree: LayoutSnapshot["tree"];
  panes: Record<string, LayoutSnapshot["panes"][string]>;
  focusedPaneId: string;
  customLayouts: ReadonlyMap<string, LayoutSnapshot>;
}

export function serializeSession(
  layout: LayoutSourceForSave,
  sendOptions: SendOptions,
  rules: PipeRule[],
  name = ""
): SessionData {
  const customLayouts: Record<string, LayoutSnapshot> = {};
  for (const [key, snap] of layout.customLayouts) {
    customLayouts[key] = snap;
  }
  return {
    layout: {
      tree: layout.tree,
      panes: layout.panes,
      focusedPaneId: layout.focusedPaneId,
      customLayouts,
    },
    sendOptions,
    rules,
    scrollbackKeys: [],
    savedAt: "",
    name,
  };
}

/**
 * Push the session's recorded pipe rules into the Rust dispatcher. Used by
 * `loadSession` / autosave-restore so a saved rule set is live the moment
 * the panes reappear. Failures are non-fatal — the rules list UI can fix
 * up rejected rules manually.
 */
export async function applySessionRules(rules: readonly PipeRule[]): Promise<void> {
  try {
    await pipeReplaceAll([...rules]);
  } catch (e) {
    console.error("[sessions] pipeReplaceAll failed", e);
  }
}

export async function saveSession(name: string, data: SessionData): Promise<void> {
  await invoke("session_save", { name, data });
}

export async function loadSession(name: string): Promise<SessionData | null> {
  const raw = (await invoke("session_load", { name })) as SessionData | undefined;
  return raw ?? null;
}

export async function listSessions(): Promise<SessionMetadata[]> {
  const raw = (await invoke("session_list")) as SessionMetadata[] | undefined;
  return raw ?? [];
}

export async function deleteSession(name: string): Promise<void> {
  await invoke("session_delete", { name });
}

export async function writeAutosave(data: SessionData): Promise<void> {
  await invoke("session_autosave_write", { data });
}

export async function readAutosave(): Promise<SessionData | null> {
  const raw = (await invoke("session_autosave_read")) as SessionData | null | undefined;
  return raw ?? null;
}

export async function writeSessionScrollback(
  name: string,
  paneId: string,
  bytes: Uint8Array,
  maxBytes: number
): Promise<void> {
  await invoke("session_scrollback_write", {
    name,
    paneId,
    bytes: Array.from(bytes),
    maxBytes,
  });
}

export async function readSessionScrollback(name: string, paneId: string): Promise<Uint8Array> {
  const raw = (await invoke("session_scrollback_read", { name, paneId })) as number[] | undefined;
  return new Uint8Array(raw ?? []);
}

export async function writeAutosaveScrollback(
  paneId: string,
  bytes: Uint8Array,
  maxBytes: number
): Promise<void> {
  await invoke("session_autosave_scrollback_write", {
    paneId,
    bytes: Array.from(bytes),
    maxBytes,
  });
}

export async function readAutosaveScrollback(paneId: string): Promise<Uint8Array> {
  const raw = (await invoke("session_autosave_scrollback_read", { paneId })) as
    | number[]
    | undefined;
  return new Uint8Array(raw ?? []);
}

export async function clearAutosaveScrollback(): Promise<void> {
  await invoke("session_autosave_scrollback_clear");
}

export interface AutosaveDriver {
  /** Build the current SessionData. Called on visibility-hidden / unload. */
  snapshot(): SessionData;
  /** Whether autosave is currently enabled (config.session.autosaveOnExit). */
  enabled(): boolean;
  /**
   * Optional side-channel for scrollback persistence. When `config.scrollback
   * .persistOnExit` is on, the driver collects each live pane's serialised
   * buffer and forwards it to the autosave-scrollback writer. The returned
   * pane ids are recorded in the SessionData so restore can read them back.
   * Implementations that don't persist scrollback can omit this.
   */
  persistScrollback?(): Promise<string[]>;
}

/**
 * Wire `visibilitychange` (tab hidden) and `beforeunload` (window close) to
 * an autosave write. Returns a teardown that removes both listeners.
 *
 * `beforeunload` can't reliably await a fire-and-forget invoke — Tauri 2's
 * IPC is sync-callable so we kick the write and don't wait. `visibilitychange`
 * does await so foreground-to-background tab switches (Cmd+Tab) fully drain
 * before the OS reclaims the page.
 */
export function installAutosave(driver: AutosaveDriver): () => void {
  if (typeof window === "undefined") return () => {};

  const onVisibility = async () => {
    if (document.visibilityState !== "hidden") return;
    if (!driver.enabled()) return;
    try {
      // Scrollback must persist *before* the JSON so the JSON's
      // `scrollbackKeys` list reflects what's on disk.
      let scrollbackKeys: string[] = [];
      if (driver.persistScrollback) {
        try {
          scrollbackKeys = await driver.persistScrollback();
        } catch {
          /* scrollback dump is best-effort */
        }
      }
      const data = driver.snapshot();
      data.scrollbackKeys = scrollbackKeys;
      await writeAutosave(data);
    } catch {
      // Autosave is best-effort — don't crash the foreground hand-off.
    }
  };
  const onUnload = () => {
    if (!driver.enabled()) return;
    // `beforeunload` doesn't reliably await async work, so we can't dump
    // the scrollback here — the JSON gets written without an updated
    // scrollback list. The visibilitychange handler above is the
    // primary path; this is only a fallback for OS-level shutdowns
    // where visibilitychange might not fire first.
    void writeAutosave(driver.snapshot()).catch(() => {});
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("beforeunload", onUnload);

  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("beforeunload", onUnload);
  };
}
