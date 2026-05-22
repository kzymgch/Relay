// Shared xterm.js stubs.
//
// xterm.js v5's CoreBrowserService requires browser APIs that jsdom does not
// implement (matchMedia + DPR plumbing). Component tests stub the modules
// here and verify wrapper contracts instead of standing up a real browser.

import { vi } from "vitest";

type OnDataCallback = (data: string) => void;
type OnResizeCallback = (event: { cols: number; rows: number }) => void;

interface MockBufferLine {
  isWrapped: boolean;
  translateToString(trim?: boolean): string;
}

// Tests usually only care about a line's text; for soft-wrap scenarios
// they upgrade specific entries to `{ text, isWrapped: true }`. Strings
// default to `isWrapped: false` (a fresh logical line).
type MockBufferEntry = string | { text: string; isWrapped?: boolean };

class MockTerminal {
  cols = 80;
  rows = 24;
  options: Record<string, unknown>;
  addons: unknown[] = [];
  openedOn: HTMLElement | null = null;
  // Mutable line list so tests can populate scrollback before exercising
  // buffer-scanning APIs (e.g. findLastUrl). `getLine(y)` returns undefined
  // past the end to match xterm's real behaviour.
  bufferLines: MockBufferEntry[] = [];
  buffer: {
    active: {
      viewportY: number;
      readonly length: number;
      getLine(y: number): MockBufferLine | undefined;
    };
  };

  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
    // Owner alias intentional: tests reassign `term.bufferLines = [...]`, so
    // closures captured here must dereference the live field via `owner`
    // rather than capturing the (then-empty) initial array.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const owner = this;
    this.buffer = {
      active: {
        viewportY: 0,
        get length(): number {
          return owner.bufferLines.length;
        },
        getLine(y: number): MockBufferLine | undefined {
          const entry = owner.bufferLines[y];
          if (entry === undefined) return undefined;
          const text = typeof entry === "string" ? entry : entry.text;
          const isWrapped = typeof entry === "string" ? false : !!entry.isWrapped;
          return {
            isWrapped,
            translateToString: (trim?: boolean) => (trim ? text.replace(/\s+$/, "") : text),
          };
        },
      },
    };
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

  // Tests can drive selection state by mutating this field directly. The
  // empty default matches xterm's real "no selection" return value.
  selection = "";
  getSelection = vi.fn(() => this.selection);
  // Optional selection range used by SelectionChip's positioner. Tests that
  // don't care about positioning can leave this `undefined`.
  selectionRange: { start: { x: number; y: number }; end: { x: number; y: number } } | undefined =
    undefined;
  getSelectionPosition = vi.fn(() => this.selectionRange);

  onSelectionChange = vi.fn((cb: () => void) => {
    state.selectionHandlers.push(cb);
    return {
      dispose: vi.fn(() => {
        const i = state.selectionHandlers.indexOf(cb);
        if (i >= 0) state.selectionHandlers.splice(i, 1);
      }),
    };
  });

  onScroll = vi.fn((cb: () => void) => {
    state.scrollHandlers.push(cb);
    return {
      dispose: vi.fn(() => {
        const i = state.scrollHandlers.indexOf(cb);
        if (i >= 0) state.scrollHandlers.splice(i, 1);
      }),
    };
  });

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
  selectionHandlers: Array<() => void>;
  scrollHandlers: Array<() => void>;
}

const state: State = {
  instances: [],
  dataHandlers: [],
  resizeHandlers: [],
  selectionHandlers: [],
  scrollHandlers: [],
};

export { MockTerminal, MockFitAddon, MockWebLinksAddon, MockSearchAddon, MockSerializeAddon };

export function resetXtermMocks(): void {
  state.instances.length = 0;
  state.dataHandlers.length = 0;
  state.resizeHandlers.length = 0;
  state.selectionHandlers.length = 0;
  state.scrollHandlers.length = 0;
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
