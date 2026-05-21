// Shared xterm.js stubs.
//
// xterm.js v5's CoreBrowserService requires browser APIs that jsdom does not
// implement (matchMedia + DPR plumbing). Component tests stub the modules
// here and verify wrapper contracts instead of standing up a real browser.

import { vi } from "vitest";

type OnDataCallback = (data: string) => void;
type OnResizeCallback = (event: { cols: number; rows: number }) => void;

class MockTerminal {
  cols = 80;
  rows = 24;
  options: Record<string, unknown>;
  addons: unknown[] = [];
  openedOn: HTMLElement | null = null;

  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
    state.instances.push(this);
  }

  loadAddon = vi.fn((addon: unknown) => {
    this.addons.push(addon);
  });

  open = vi.fn((el: HTMLElement) => {
    this.openedOn = el;
    el.classList.add("xterm-mounted");
  });

  write = vi.fn();
  clear = vi.fn();
  focus = vi.fn();

  paste = vi.fn((data: string) => {
    for (const cb of state.dataHandlers) cb(data);
  });

  onData = vi.fn((cb: OnDataCallback) => {
    state.dataHandlers.push(cb);
    return {
      dispose: vi.fn(() => {
        const i = state.dataHandlers.indexOf(cb);
        if (i >= 0) state.dataHandlers.splice(i, 1);
      }),
    };
  });

  onResize = vi.fn((cb: OnResizeCallback) => {
    state.resizeHandlers.push(cb);
    return {
      dispose: vi.fn(() => {
        const i = state.resizeHandlers.indexOf(cb);
        if (i >= 0) state.resizeHandlers.splice(i, 1);
      }),
    };
  });

  dispose = vi.fn(() => {
    this.openedOn?.classList.remove("xterm-mounted");
  });
}

class MockFitAddon {
  fit = vi.fn();
}
class MockWebLinksAddon {}
class MockSearchAddon {
  findNext = vi.fn(() => true);
  findPrevious = vi.fn(() => true);
}
class MockSerializeAddon {
  serialize = vi.fn(() => "serialized");
}

interface State {
  instances: MockTerminal[];
  dataHandlers: OnDataCallback[];
  resizeHandlers: OnResizeCallback[];
}

const state: State = {
  instances: [],
  dataHandlers: [],
  resizeHandlers: [],
};

export { MockTerminal, MockFitAddon, MockWebLinksAddon, MockSearchAddon, MockSerializeAddon };

export function resetXtermMocks(): void {
  state.instances.length = 0;
  state.dataHandlers.length = 0;
  state.resizeHandlers.length = 0;
}

export function getXtermState(): State {
  return state;
}

export function emitTerminalData(data: string): void {
  for (const cb of state.dataHandlers) cb(data);
}

export function emitTerminalResize(cols: number, rows: number): void {
  for (const cb of state.resizeHandlers) cb({ cols, rows });
}
