// Reactive wrapper around the `RelayConfig` from `./config.ts`.
//
// Svelte 5 runes only work inside `.svelte` / `.svelte.ts` modules, so this
// file is named accordingly. The factory pattern matches `layout/store.svelte.ts`
// — tests can spin up a fresh store with a seeded value, production code goes
// through `createConfigStore()` once in `AppRoot.svelte`.

import { defaultConfig, loadConfig, onConfigChanged, saveConfig, type RelayConfig } from "./config";

export interface ConfigStore {
  /** Reactive snapshot. Reads inside `$derived` / template re-trigger. */
  readonly current: RelayConfig;
  /** Replace the whole config and persist (used by Settings → Save). */
  set(next: RelayConfig): Promise<void>;
  /** Shallow-merge a patch, persist, and update the reactive copy. */
  update(patch: Partial<RelayConfig>): Promise<void>;
  /** Hydrate from disk + subscribe to external edits. Returns the unsubscribe. */
  attach(): Promise<() => void>;
}

export function createConfigStore(initial?: RelayConfig): ConfigStore {
  let current: RelayConfig = $state(initial ?? defaultConfig());

  async function persist(next: RelayConfig): Promise<void> {
    current = next;
    // Best-effort: in tests, mockIPC returns undefined for `config_save`
    // and that's fine — the reactive copy still reflects the edit. In prod
    // a real failure (validation) propagates so the caller can show it.
    await saveConfig(next);
  }

  return {
    get current() {
      return current;
    },
    set(next) {
      return persist(next);
    },
    update(patch) {
      return persist({ ...current, ...patch });
    },
    async attach() {
      // 1. Pull the current Rust copy first so the reactive value reflects
      //    real on-disk state instead of the synchronous default.
      try {
        current = await loadConfig();
      } catch {
        // Stay on defaults — Rust likely rejected the file; UI will still work.
      }
      // 2. Subscribe to external edits via the watcher's `config:changed`
      //    event. The listener also keeps `current` in lockstep when the
      //    user edits config.toml in another editor.
      return await onConfigChanged((cfg) => {
        current = cfg;
      });
    },
  };
}
