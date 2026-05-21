// Pane-to-pane pipe rules (spec §9) — TS bindings.
//
// The Rust dispatcher in `src-tauri/src/pipe.rs` owns the wire format; this
// module mirrors `PipeRule` / `PipeMode` and exposes the CRUD commands plus
// the event listeners the UI uses for toasts.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PipeMode =
  | { kind: "lineRealtime" }
  | { kind: "regexMatch"; pattern: string }
  | { kind: "tailPeriodic"; lines: number; intervalMs: number }
  | { kind: "onExit" };

export interface PipeRule {
  id: string;
  source: string;
  target: string;
  enabled: boolean;
  mode: PipeMode;
  include: string | null;
  exclude: string | null;
  stripAnsi: boolean;
}

export interface PipeFiredPayload {
  ruleId: string;
  count: number;
}

export interface PipeAutoDisabledPayload {
  ruleId: string;
  reason: string;
}

export interface PipeCycleRejectedPayload {
  ruleId: string;
  source: string;
  target: string;
}

export interface PipeTargetGonePayload {
  ruleId: string;
  target: string;
}

export const EVENT_PIPE_FIRED = "pipe:fired";
export const EVENT_PIPE_AUTO_DISABLED = "pipe:autoDisabled";
export const EVENT_PIPE_CYCLE_REJECTED = "pipe:cycleRejected";
export const EVENT_PIPE_TARGET_GONE = "pipe:targetGone";

/** Default mode for the "Add rule" form. */
export function defaultPipeMode(): PipeMode {
  return { kind: "lineRealtime" };
}

/** Render a short, screen-friendly summary of a mode for the rules table. */
export function formatPipeMode(mode: PipeMode): string {
  switch (mode.kind) {
    case "lineRealtime":
      return "line realtime";
    case "regexMatch":
      return `regex match ${mode.pattern}`;
    case "tailPeriodic":
      return `tail ${mode.lines} every ${mode.intervalMs} ms`;
    case "onExit":
      return "on exit";
  }
}

export async function pipeList(): Promise<PipeRule[]> {
  const raw = (await invoke("pipe_list")) as PipeRule[] | undefined;
  return raw ?? [];
}

export async function pipeUpsert(rule: PipeRule): Promise<void> {
  await invoke("pipe_upsert", { rule });
}

export async function pipeDelete(id: string): Promise<void> {
  await invoke("pipe_delete", { id });
}

export async function pipeToggle(id: string, enabled: boolean): Promise<void> {
  await invoke("pipe_toggle", { id, enabled });
}

export async function pipeReplaceAll(rules: PipeRule[]): Promise<void> {
  await invoke("pipe_replace_all", { rules });
}

export async function onPipeFired(
  handler: (payload: PipeFiredPayload) => void
): Promise<UnlistenFn> {
  return listen<PipeFiredPayload>(EVENT_PIPE_FIRED, (e) => handler(e.payload));
}

export async function onPipeAutoDisabled(
  handler: (payload: PipeAutoDisabledPayload) => void
): Promise<UnlistenFn> {
  return listen<PipeAutoDisabledPayload>(EVENT_PIPE_AUTO_DISABLED, (e) => handler(e.payload));
}

export async function onPipeCycleRejected(
  handler: (payload: PipeCycleRejectedPayload) => void
): Promise<UnlistenFn> {
  return listen<PipeCycleRejectedPayload>(EVENT_PIPE_CYCLE_REJECTED, (e) => handler(e.payload));
}

export async function onPipeTargetGone(
  handler: (payload: PipeTargetGonePayload) => void
): Promise<UnlistenFn> {
  return listen<PipeTargetGonePayload>(EVENT_PIPE_TARGET_GONE, (e) => handler(e.payload));
}
