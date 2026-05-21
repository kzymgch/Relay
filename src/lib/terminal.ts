import type { ITheme } from "@xterm/xterm";

/**
 * Imperative handle to a mounted Terminal component. Delivered via the
 * `onready` callback once the underlying xterm instance is initialised.
 */
export interface TerminalApi {
  write(data: string | Uint8Array): void;
  clear(): void;
  focus(): void;
  /** Recompute terminal cell dimensions from the container's current size. */
  fit(): void;
  /** Inject text as if it had been pasted by the user (triggers `ondata`). */
  paste(data: string): void;
  /** Snapshot the current buffer as a string (ANSI sequences included). */
  serialize(): string;
  findNext(query: string): boolean;
  findPrevious(query: string): boolean;
  /**
   * The user-selected text in the terminal, or `undefined` when there is no
   * selection. Used by PR-08 inter-pane send to pull the source text without
   * forcing the user to copy it first.
   */
  getSelection(): string | undefined;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalProps {
  /** Reactive — re-applied to the live terminal whenever the prop changes. */
  theme?: ITheme;
  /** Reactive — re-applied to the live terminal whenever the prop changes. */
  fontFamily?: string;
  /** Reactive — re-applied to the live terminal whenever the prop changes. */
  fontSize?: number;
  /** Reactive — re-applied to the live terminal whenever the prop changes. */
  cursorBlink?: boolean;
  /**
   * Reactive: re-applied to the live terminal when the prop changes.
   * Note that *shrinking* the buffer drops the oldest history — that's a
   * property of xterm.js's resize, not a bug here.
   */
  scrollback?: number;
  /** Pane id stamped on the DataTransfer payload by the SelectionChip so
   *  drop targets can reject same-source drops. The chip is suppressed when
   *  `paneId` is absent (used in unit tests that mount Terminal directly). */
  paneId?: string;
  /** Human label for the source pane, surfaced in the send preview modal. */
  sourceLabel?: string;
  ondata?: (data: string) => void;
  onresize?: (cols: number, rows: number) => void;
  onready?: (api: TerminalApi) => void;
}
