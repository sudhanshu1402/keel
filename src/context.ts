import type { RetryPolicy } from './retry.js';

export interface StepOptions {
  retry?: Partial<RetryPolicy>;
  /**
   * Fail the step if `fn` has not settled within this many milliseconds. The
   * timeout applies per attempt. On timeout the step's `AbortSignal` is aborted
   * so a cooperative `fn` can stop its work, and a `TimeoutError` is raised.
   * Timeouts are NOT retried by default (a retry would spawn a second copy of a
   * side effect that may still be running); pass your own `retry.retryable` to
   * opt back in.
   */
  timeoutMs?: number;
  /**
   * A stable key for the side effect this step performs, surfaced to `fn` via
   * its helpers. keel is at-least-once: a step whose side effect ran but whose
   * process crashed before the result was persisted re-runs on resume. Pass
   * this key to your downstream API (Stripe's `Idempotency-Key`, an upsert
   * primary key, etc.) so the duplicate is collapsed. Defaults to
   * `"<runId>:<stepName>"`, which is stable across replays of the same step.
   */
  idempotencyKey?: string;
}

/**
 * Per-attempt helpers passed to a step's `fn`. The first parameter is optional:
 * existing zero-argument step functions keep working unchanged.
 */
export interface StepHelpers {
  /** 1-based attempt counter; increments on each retry. */
  readonly attempt: number;
  /** Aborted when the step's `timeoutMs` elapses. Forward to fetch/etc. */
  readonly signal: AbortSignal;
  /** The step's idempotency key (see `StepOptions.idempotencyKey`). */
  readonly idempotencyKey: string;
}

export interface LlmArgs {
  prompt: string;
  model?: string;
}

export interface LlmResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
}

/**
 * The handle a workflow uses to record durable steps. Any work whose result
 * must survive a restart, or that has side effects or nondeterminism, must go
 * through one of these methods.
 */
export interface WorkflowContext {
  readonly runId: string;
  /** Run fn once, persist its result, and replay that result on later runs. */
  step<T>(
    name: string,
    fn: (helpers: StepHelpers) => Promise<T> | T,
    opts?: StepOptions,
  ): Promise<T>;
  /**
   * Run several steps concurrently and durably. Each entry becomes a child step
   * named `"<name>#<i>"`; their call positions are reserved in array order
   * before any of them runs, so replay stays deterministic regardless of which
   * finishes first. Results are returned in input order, and each child is
   * memoized independently, so a resume re-runs only the ones that had not
   * completed.
   */
  all<T>(
    name: string,
    fns: ReadonlyArray<(helpers: StepHelpers) => Promise<T> | T>,
    opts?: StepOptions,
  ): Promise<T[]>;
  /** Durable delay. Survives restarts; replays instantly once elapsed. */
  sleep(name: string, ms: number): Promise<void>;
  /**
   * Pause the run until a signal of this name arrives via `keel.sendSignal`.
   * The delivered value is persisted and replayed like any other step, so a
   * resume after the signal never blocks again. Used for human-in-the-loop
   * approvals, webhooks, and inter-workflow coordination.
   */
  waitForSignal<T = unknown>(name: string): Promise<T>;
  /** A step backed by the configured LLM provider, with token capture. */
  llm(name: string, args: LlmArgs): Promise<LlmResult>;
  /**
   * Record the current wall-clock time as a durable step and replay it on
   * resume. Use this instead of `Date.now()` inside a workflow so replays are
   * deterministic. Auto-names the step when no name is given.
   */
  now(name?: string): Promise<number>;
  /**
   * A durable random number in [0, 1). Recorded once and replayed on resume,
   * so the workflow stays deterministic. Auto-names the step when none given.
   */
  random(name?: string): Promise<number>;
  /**
   * A durable UUID (v4). Generated once, persisted, and replayed on resume.
   * Auto-names the step when no name is given.
   */
  uuid(name?: string): Promise<string>;
}
