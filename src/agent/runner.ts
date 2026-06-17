export type AgentRunOptions = {
  prompt: string;
  model: string;
  /**
   * Hard token budget forwarded to gantry's `--max-tokens`. Counts
   * `input + output + cache_write` (cache_read excluded — see gantry's G7
   * formula); the run stops with exit `budget` once the running total meets or
   * exceeds it. Budgets are tokens end-to-end: no USD reaches the subprocess.
   */
  maxTokens: number;
  workingDir: string;
  env: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Review mode, forwarded to gantry's `--mode` (overrides the profile default). */
  mode: 'single' | 'team';
  /**
   * User skill names, appended as repeated `--inject-skill` flags after the
   * profile's invariant skill set. Resolved against `skillsDir`, never the
   * (hostile) workdir.
   */
  extraSkills?: string[];
  /**
   * Per-run skill staging directory, forwarded to gantry's `--skills-dir`.
   * Trusted content assembled outside the PR checkout; governs both
   * `--inject-skill` resolution and the `skill_load` tool.
   */
  skillsDir?: string;
  /**
   * Path to the per-run rendered unify-phase prompt, forwarded to gantry's
   * `--unify-file` (team mode only; ignored by gantry outside team mode).
   */
  unifyPromptPath?: string;
};

export type AgentTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
};

export type AgentResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  tokenUsage: AgentTokenUsage | null;
  /**
   * Canonical `provider/model` slug the run actually used (resolved from the
   * requested reference). Threaded to persistence so cost aggregation keys on a
   * single canonical form. Absent only for fakes that don't set it.
   */
  model?: string;
  /**
   * Buffered NDJSON event stream from the gantry subprocess, in emission order.
   * Absent for fakes (workflow tests) — `persistUsageStep` falls back to a
   * single aggregate usage row when this is undefined.
   */
  events?: AgentEvent[];
};

/**
 * Gantry NDJSON event vocabulary — schema_version `"1.1"` (gantry v0.1.0,
 * `d9e885d`). Each line gantry writes to stdout is one of these objects;
 * `GantryRunner` parses them as they arrive and buffers the list onto
 * `AgentResult.events`.
 *
 * Field names are snake_case because they are decoded verbatim from the wire —
 * wrily's own option/result types stay camelCase. Source of truth: the gantry
 * README "Event stream (NDJSON)" table @ v0.1.0 and the cutover handoff
 * (`solo://proj/11/scratchpad/gantry-v0-1-0-cutove--49`).
 */

/** Terminal `result.exit` status; mirrors gantry's process exit code. */
export type GantryExit =
  | 'ok' //           0
  | 'error' //        1
  | 'budget' //       2
  | 'timeout' //      3
  | 'config' //       4
  | 'rate_limited'; // 5 — recoverable (back off + retry)

/**
 * Agent identity carried on per-turn events. Reserved values are `'single'`
 * (single mode) and `'coordinator'` (team coordinator turns); any other value
 * is a team subagent's `name`. Persistence keys per-role accumulation on this,
 * so the `(string & {})` arm keeps subagent names typeable while preserving the
 * two reserved-literal hints.
 */
export type GantryRole = 'single' | 'coordinator' | (string & {});

/**
 * Why a team subagent was failed individually (the run continues, dropping that
 * lane). `'budget'` = slice exceeded, `'panic'` = subagent task panicked;
 * anything else is free-form provider error text.
 */
export type GantrySubagentFailReason = 'budget' | 'panic' | (string & {});

/**
 * Terminal `error.kind`. Only `provider` (and a transient provider failure) is
 * ever `recoverable`; `config` / `team_collapse` / `internal` are fatal.
 */
export type GantryErrorKind = 'config' | 'provider' | 'team_collapse' | 'internal';

interface GantryEventBase {
  /** Emission time, epoch milliseconds. */
  ts: number;
}

/** Run begins. Always the first event of a successfully-started run. */
export interface StartEvent extends GantryEventBase {
  event: 'start';
  /** Version-guarded to `"1.1"`; the parser warns (does not throw) on mismatch. */
  schema_version: string;
  model: string;
  provider: string;
  mode: string;
  workdir: string;
}

/** A skill was injected into the system prompt at startup. */
export interface SkillLoadedEvent extends GantryEventBase {
  event: 'skill_loaded';
  name: string;
  bytes: number;
}

/**
 * One model call. Emitted for `single` and `coordinator` roles only — subagents
 * report aggregate totals via `subagent_done` and emit no `agent_turn`.
 */
export interface AgentTurnEvent extends GantryEventBase {
  event: 'agent_turn';
  role: GantryRole;
  turn: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  /** Wall time of this model call. */
  duration_ms: number;
}

/** A tool was invoked. `args` is the tool's JSON arguments, encoded as a string. */
export interface ToolCallEvent extends GantryEventBase {
  event: 'tool_call';
  role: GantryRole;
  turn: number;
  tool: string;
  args: string;
}

/** A tool returned. `bytes` is raw size; `bytes_out` is post-compression size. */
export interface ToolResultEvent extends GantryEventBase {
  event: 'tool_result';
  role: GantryRole;
  turn: number;
  tool: string;
  bytes: number;
  bytes_out: number;
  truncated: boolean;
  /** Content-addressed recovery handle for capped output (compression only). */
  handle?: string;
  error?: string;
}

/** Model free-text output. */
export interface AssistantTextEvent extends GantryEventBase {
  event: 'assistant_text';
  role: GantryRole;
  text: string;
}

/** A team subagent started. `scope` describes the lane the coordinator assigned. */
export interface SubagentSpawnEvent extends GantryEventBase {
  event: 'subagent_spawn';
  name: string;
  scope: string;
}

/** A team subagent finished, carrying its aggregate token/cache/duration totals. */
export interface SubagentDoneEvent extends GantryEventBase {
  event: 'subagent_done';
  name: string;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  /** Spawn→done wall time. */
  duration_ms: number;
}

/** A team subagent was failed individually; the run continues without it. */
export interface SubagentFailedEvent extends GantryEventBase {
  event: 'subagent_failed';
  name: string;
  reason: GantrySubagentFailReason;
}

/** Loop-mode iteration boundary (start). Unused by wrily (single/team only). */
export interface IterationStartEvent extends GantryEventBase {
  event: 'iteration_start';
  iteration: number;
}

/** Loop-mode iteration boundary (end). Unused by wrily (single/team only). */
export interface IterationEndEvent extends GantryEventBase {
  event: 'iteration_end';
  iteration: number;
  stopped: boolean;
}

/** Transcript compaction ran (single/loop modes with `--context-limit`). */
export interface HistoryCompactedEvent extends GantryEventBase {
  event: 'history_compacted';
  role: GantryRole;
  turn: number;
  results_elided: number;
  input_tokens: number;
}

/**
 * The global token cap tripped. Emitted at most once per run;
 * `total = input + output + cache_write` (matching the `--max-tokens` formula).
 */
export interface BudgetExceededEvent extends GantryEventBase {
  event: 'budget_exceeded';
  limit: number;
  total: number;
}

/**
 * `--isolate` teardown audit: every file the run modified in the copy-on-write
 * shadow workspace. Wrily's profile sets `isolate = true`, so this is emitted.
 */
export interface ChangesEvent extends GantryEventBase {
  event: 'changes';
  files: Array<{ path: string; kind: string }>;
}

/**
 * A recoverable or terminal error. `recoverable` is `true` only for provider
 * rate-limits / transient failures; `retry_after_ms` is present only when the
 * provider supplied a back-off hint.
 */
export interface ErrorEvent extends GantryEventBase {
  event: 'error';
  kind: GantryErrorKind;
  message: string;
  recoverable?: boolean;
  retry_after_ms?: number;
}

/** Terminal event — always emitted last. Token totals are run-wide. */
export interface ResultEvent extends GantryEventBase {
  event: 'result';
  exit: GantryExit;
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_write: number;
  duration_ms: number;
}

/**
 * Discriminated union (discriminant: `event`) over gantry's complete
 * schema-1.1 NDJSON vocabulary, buffered onto `AgentResult.events` by
 * `GantryRunner`.
 */
export type AgentEvent =
  | StartEvent
  | SkillLoadedEvent
  | AgentTurnEvent
  | ToolCallEvent
  | ToolResultEvent
  | AssistantTextEvent
  | SubagentSpawnEvent
  | SubagentDoneEvent
  | SubagentFailedEvent
  | IterationStartEvent
  | IterationEndEvent
  | HistoryCompactedEvent
  | BudgetExceededEvent
  | ChangesEvent
  | ErrorEvent
  | ResultEvent;

export interface AgentRunner {
  run(opts: AgentRunOptions): Promise<AgentResult>;
}
