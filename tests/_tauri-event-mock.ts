// In-memory replacement for @tauri-apps/api/event's `listen` so tests can
// emit events that would otherwise come from Rust via the Tauri runtime.

type Handler = (event: { payload: unknown }) => void;

const listeners = new Map<string, Set<Handler>>();

export async function listen(name: string, handler: Handler): Promise<() => void> {
  let set = listeners.get(name);
  if (!set) {
    set = new Set();
    listeners.set(name, set);
  }
  set.add(handler);
  return () => {
    listeners.get(name)?.delete(handler);
  };
}

export function emitTauriEvent(name: string, payload: unknown): void {
  for (const handler of listeners.get(name) ?? []) {
    handler({ payload });
  }
}

export function resetTauriEventListeners(): void {
  listeners.clear();
}

export function listenerCount(name: string): number {
  return listeners.get(name)?.size ?? 0;
}
