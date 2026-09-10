/**
 * Single session lifecycle state machine (ADR-0004 Invariant 2).
 *
 *   inactive ──(ensure/newSession success)──▶ ready ──(prompt)──▶ busy ──▶ ready
 *      ▲                                          │
 *      └────────────(idle timeout: dispose)───────┘
 *
 *   ready/busy ──(newSession)──▶ replacing ──▶ ready | faulted
 *   any        ──(fatal diagnostics)──▶ faulted
 */
export type SessionState = "inactive" | "ready" | "busy" | "replacing" | "faulted";

/** Busy/UI-waiting refusal reply (no queue). */
export const BUSY_REPLY = "⚠️ 当前 Agent 正在执行任务，请稍后再试。";
