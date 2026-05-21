// Inter-pane text send (spec §8).
//
// Responsibilities:
//   - Hold the per-session send options (bracketed paste, trailing newline)
//     that the UI and keybindings consult.
//   - Track a bounded send history so users can re-send recent payloads.
//   - Provide `sendTextTo(...)` which routes a payload through the Rust
//     `pty_send_text` command (which is where the bracketed-paste framing
//     actually lives — see `bridge::build_send_payload`).
//
// The frontend deliberately does *not* build the bracketed-paste byte stream
// itself: keeping the wrapping policy on the Rust side means the wire format
// is tested in one place and stays consistent if PR-18 adds GUI knobs for
// the framing details.

import { sendPtyText, type PaneId } from "./pty";

export interface SendOptions {
  /**
   * Wrap the payload in `\e[200~ ... \e[201~`. Defaults to `true` so the
   * receiving shell can distinguish pasted text from typed commands.
   */
  bracketedPaste: boolean;
  /**
   * Append a `\n` after the bracketed-paste close marker. Defaults to
   * `false` per spec §8 ("末尾改行付与の ON / OFF を切替可能 (デフォルト: OFF)").
   */
  trailingNewline: boolean;
}

export const DEFAULT_SEND_OPTIONS: SendOptions = {
  bracketedPaste: true,
  trailingNewline: false,
};

/** Max entries retained in the send history. Sized to fit a session's worth
 * of commands without growing the in-memory state without bound. */
export const SEND_HISTORY_LIMIT = 50;

export interface SendHistoryEntry {
  text: string;
  /** Pane the user sent *from*. Carried for UI display only. */
  sourceLabel: string;
  /** Pane the payload was delivered to. Carried for UI display only. */
  targetLabel: string;
  /** Options used at the time of send — preserved so re-sends can match. */
  options: SendOptions;
  /** Epoch milliseconds at the time of send, set with `Date.now()`. */
  timestamp: number;
}

/**
 * Resolves the pane API for a target id at call time. The registry is owned
 * by the page, which knows which panes are currently running.
 */
export interface SendTargetResolver {
  resolve(targetId: PaneId): { ptyId: PaneId } | undefined;
}

/**
 * Bounded ring buffer of recent sends.
 *
 * Newest entries are at index 0 — UIs typically render the most recent
 * send at the top of a dropdown / palette.
 */
export class SendHistory {
  private entries: SendHistoryEntry[] = [];

  constructor(private readonly limit: number = SEND_HISTORY_LIMIT) {}

  push(entry: SendHistoryEntry): void {
    this.entries.unshift(entry);
    if (this.entries.length > this.limit) {
      this.entries.length = this.limit;
    }
  }

  list(): readonly SendHistoryEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries.length = 0;
  }
}

export interface SendRequest {
  text: string;
  targetPtyId: PaneId;
  sourceLabel: string;
  targetLabel: string;
  options?: Partial<SendOptions>;
}

/**
 * Send `text` to the target pane's PTY and record the send in `history`.
 *
 * Empty / whitespace-only payloads are skipped — the spec calls for sending
 * the selection, and an empty selection should be a no-op rather than
 * injecting a bare bracketed-paste burst into the receiver.
 */
export async function sendTextTo(
  request: SendRequest,
  history: SendHistory,
  defaults: SendOptions = DEFAULT_SEND_OPTIONS
): Promise<boolean> {
  if (request.text.length === 0) return false;

  const options: SendOptions = {
    bracketedPaste: request.options?.bracketedPaste ?? defaults.bracketedPaste,
    trailingNewline: request.options?.trailingNewline ?? defaults.trailingNewline,
  };

  await sendPtyText(
    request.targetPtyId,
    request.text,
    options.bracketedPaste,
    options.trailingNewline
  );

  history.push({
    text: request.text,
    sourceLabel: request.sourceLabel,
    targetLabel: request.targetLabel,
    options,
    timestamp: Date.now(),
  });
  return true;
}
