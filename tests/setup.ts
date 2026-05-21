// Global test setup. Loaded by vitest via `test.setupFiles`.

// jsdom does not implement ResizeObserver. Provide a no-op so components and
// addons that rely on it (xterm.js, our Terminal wrapper) can mount.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
