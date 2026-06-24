import { randomUUID } from 'node:crypto';
import type {
  LlmArgs,
  LlmResult,
  StepHelpers,
  StepOptions,
  WorkflowContext,
} from './context.js';
import {
  CancelledError,
  DivergenceError,
  PausedError,
  StepFailedError,
  TimeoutError,
  WorkflowVersionError,
} from './errors.js';
import type { Provider } from './providers/types.js';
import { defaultStepRetry, runWithRetry, type RetryPolicy } from './retry.js';
import { MemoryStore } from './store/memory.js';
import type { RunRecord, RunStatus, StepRecord, Store } from './store/types.js';
import type { WorkflowDefinition } from './workflow.js';

/**
 * A step lifecycle event. `step:start` fires when a step actually executes (not
 * on a memoized replay); `step:complete` and `step:fail` carry the elapsed
 * `durationMs`. Wire `onEvent` to an OpenTelemetry span, a metric, or a log
 * line. The callback runs inside the engine but anything it throws is swallowed
 * so observability can never break a run; do not do slow work in it.
 */
export interface KeelEvent {
  type: 'step:start' | 'step:complete' | 'step:fail';
  runId: string;
  /** Step name (for `ctx.llm` this is the llm call's name). */
  step: string;
  /** Positional index in the run's durable-op sequence. */
  index: number;
  /** `kind: 'step'` for ctx.step/all/now/random/uuid, `'llm'` for ctx.llm. */
  kind: 'step' | 'llm';
  /** Attempts taken so far (0 at start). */
  attempts: number;
  /** Timestamp from the engine clock. */
  at: number;
  /** Elapsed time since the step started; present on complete/fail. */
  durationMs?: number;
  /** Error message; present on fail. */
  error?: string;
}

export interface KeelOptions {
  store?: Store;
  provider?: Provider;
  /** Override id generation (useful in tests for stable ids). */
  idFactory?: () => string;
  /** Override the delay primitive (tests inject an instant sleep). */
  sleepFn?: (ms: number) => Promise<void>;
  /** Override the clock (tests inject a controllable now). */
  now?: () => number;
  /**
   * When true, `ctx.sleep` suspends the run (pausing it durably) instead of
   * blocking the process, and a `Supervisor` wakes it once the timer is due.
   * This survives a process exit during the sleep. Defaults to false, which
   * keeps the simple in-process sleep used by single-shot scripts and tests.
   */
  durableTimers?: boolean;
  /**
   * Optional step-lifecycle callback. Use it to emit traces/metrics (e.g. an
   * OpenTelemetry span per step). Thrown errors are swallowed; keep it fast.
   */
  onEvent?: (event: KeelEvent) => void;
}

export interface RunResult<O = unknown> {
  runId: string;
  status: RunStatus;
  output?: O;
  error?: string;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Race `work` against a timer. On timeout the controller is aborted (so a
 * cooperative `work` can stop) and the promise rejects with `TimeoutError`.
 */
function withTimeout<T>(
  work: () => Promise<T> | T,
  ms: number,
  stepName: string,
  controller: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(stepName, ms));
    }, ms);
    if (typeof timer === 'object' && typeof timer.unref === 'function') {
      timer.unref();
    }
    Promise.resolve(work()).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

let counter = 0;
const defaultIdFactory = (): string => {
  counter += 1;
  return `run_${Date.now().toString(36)}_${counter.toString(36)}`;
};

/**
 * The durable execution engine. A workflow handler records every side effect
 * as a named step; on a second pass (resume after crash) completed steps return
 * their persisted result instead of running again, so the handler deterministically
 * fast-forwards to where it left off.
 *
 * Execution is at-least-once: a step whose side effect ran but whose process
 * crashed before its result was persisted re-runs on resume. Use
 * `StepOptions.idempotencyKey` (or `ctx.step`'s `helpers.idempotencyKey`) to
 * make those side effects safe to repeat. Completed steps, and runs that have
 * reached `completed` or `cancelled`, never re-execute.
 */
export class Keel {
  private readonly store: Store;
  private readonly provider?: Provider;
  private readonly idFactory: () => string;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly durableTimers: boolean;
  private readonly onEvent?: (event: KeelEvent) => void;
  private readonly registry = new Map<string, WorkflowDefinition>();

  constructor(opts: KeelOptions = {}) {
    this.store = opts.store ?? new MemoryStore();
    this.provider = opts.provider;
    this.idFactory = opts.idFactory ?? defaultIdFactory;
    this.sleepFn = opts.sleepFn ?? realSleep;
    this.now = opts.now ?? (() => Date.now());
    this.durableTimers = opts.durableTimers ?? false;
    this.onEvent = opts.onEvent;
  }

  /** The store backing this engine, exposed for supervisors and tooling. */
  get backingStore(): Store {
    return this.store;
  }

  /**
   * Deliver a signal to a run. If the run is paused waiting for it, the run is
   * resumed and its result returned; otherwise the signal is stored for when
   * the run reaches `ctx.waitForSignal(name)`.
   */
  async sendSignal<O = unknown>(
    runId: string,
    name: string,
    value: unknown,
  ): Promise<RunResult<O> | undefined> {
    await this.store.saveSignal({
      runId,
      name,
      value,
      createdAt: this.now(),
    });
    const run = await this.store.getRun(runId);
    if (run && run.status === 'paused') {
      return this.resume<O>(runId);
    }
    return undefined;
  }

  /** Make a workflow resumable by id without re-supplying its definition. */
  register(def: WorkflowDefinition): void {
    this.registry.set(def.name, def);
  }

  async run<I, O>(
    def: WorkflowDefinition<I, O>,
    input: I,
  ): Promise<RunResult<O>> {
    this.register(def as WorkflowDefinition);
    const id = this.idFactory();
    const ts = this.now();
    const run: RunRecord = {
      id,
      workflowName: def.name,
      status: 'running',
      input,
      version: 0,
      workflowVersion: def.version,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.store.createRun(run);
    return this.execute(def, id, input);
  }

  /**
   * Request cancellation of a run. Cooperative: a running handler stops at its
   * next durable op (step/sleep/llm/waitForSignal), and a paused or queued run
   * will not resume. Returns true if the run moved to `cancelled`, false if it
   * had already finished.
   */
  async cancel(runId: string): Promise<boolean> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (
      run.status === 'completed' ||
      run.status === 'failed' ||
      run.status === 'cancelled'
    ) {
      return false;
    }
    await this.store.updateRun(runId, {
      status: 'cancelled',
      updatedAt: this.now(),
    });
    return true;
  }

  /**
   * Create a run without executing it, returning its id. A `Worker` polling the
   * same store claims and executes it later. This is the entry point for
   * multi-worker mode; use `run` for inline single-process execution.
   */
  async enqueue<I>(def: WorkflowDefinition<I>, input: I): Promise<string> {
    this.register(def as WorkflowDefinition);
    const id = this.idFactory();
    const ts = this.now();
    const run: RunRecord = {
      id,
      workflowName: def.name,
      status: 'queued',
      input,
      version: 0,
      workflowVersion: def.version,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.store.createRun(run);
    return id;
  }

  /** Resume a run by id. The workflow must have been registered (run() does so). */
  async resume<O = unknown>(runId: string): Promise<RunResult<O>> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    // Terminal states never re-execute. A completed run replays its recorded
    // output; a cancelled run stays cancelled. This is what guarantees a
    // finished workflow's side effects are not repeated by a stray resume.
    if (run.status === 'completed') {
      return {
        runId,
        status: 'completed',
        ...(run.output !== undefined ? { output: run.output as O } : {}),
      } as RunResult<O>;
    }
    if (run.status === 'cancelled') {
      return {
        runId,
        status: 'cancelled',
        ...(run.error ? { error: run.error } : {}),
      } as RunResult<O>;
    }
    const def = this.registry.get(run.workflowName);
    if (!def) {
      throw new Error(
        `workflow ${run.workflowName} is not registered; call register() first`,
      );
    }
    const runVersion = run.workflowVersion ?? 1;
    if (runVersion !== def.version) {
      throw new WorkflowVersionError(run.workflowName, runVersion, def.version);
    }
    await this.store.updateRun(runId, {
      status: 'running',
      updatedAt: this.now(),
    });
    return this.execute(def, runId, run.input) as Promise<RunResult<O>>;
  }

  private async execute<I, O>(
    def: WorkflowDefinition<I, O>,
    runId: string,
    input: I,
  ): Promise<RunResult<O>> {
    const priorSteps = await this.store.listSteps(runId);
    const ctx = this.makeContext(runId, priorSteps);
    try {
      const output = await def.handler(ctx, input);
      // A cancel that lands while the final pass is running must win over the
      // completion write, or the run would silently complete despite cancel.
      const latest = await this.store.getRun(runId);
      if (latest && latest.status === 'cancelled') {
        return { runId, status: 'cancelled' };
      }
      await this.store.updateRun(runId, {
        status: 'completed',
        output,
        updatedAt: this.now(),
      });
      return { runId, status: 'completed', output };
    } catch (err) {
      if (err instanceof PausedError) {
        await this.store.updateRun(runId, {
          status: 'paused',
          updatedAt: this.now(),
        });
        return { runId, status: 'paused' };
      }
      if (err instanceof CancelledError) {
        await this.store.updateRun(runId, {
          status: 'cancelled',
          updatedAt: this.now(),
        });
        return { runId, status: 'cancelled' };
      }
      const message = err instanceof Error ? err.message : String(err);
      await this.store.updateRun(runId, {
        status: 'failed',
        error: message,
        updatedAt: this.now(),
      });
      // Divergence is a programming error (the workflow code changed under a
      // live run), not a workflow-level failure. Surface it to the caller.
      if (err instanceof DivergenceError) throw err;
      return { runId, status: 'failed', error: message };
    }
  }

  private makeContext(runId: string, priorSteps: StepRecord[]): WorkflowContext {
    const store = this.store;
    const provider = this.provider;
    const sleepFn = this.sleepFn;
    const now = this.now;
    const durableTimers = this.durableTimers;
    const onEvent = this.onEvent;

    // Fire a lifecycle event, swallowing anything the user callback throws so
    // observability can never break a run.
    const emit = (event: KeelEvent): void => {
      if (!onEvent) return;
      try {
        onEvent(event);
      } catch {
        /* observability is best-effort */
      }
    };

    // Deterministic replay guard. Every durable op advances a sequence counter;
    // the first time a step is reached its position is recorded as `index`. On
    // replay the recorded name at each position must match, or the workflow's
    // code has changed underneath the run. This is a best-effort positional
    // check (it catches renames, reorders, inserts, and removals at or before
    // the divergence point); `defineWorkflow({ version })` is the hard guard for
    // intentional changes. See docs/LIMITATIONS.md.
    const indexToName = new Map<number, string>();
    for (const s of priorSteps) {
      if (s.index !== undefined) indexToName.set(s.index, s.name);
    }
    let seq = 0;
    const claimIndex = (name: string): number => {
      const recorded = indexToName.get(seq);
      if (recorded !== undefined && recorded !== name) {
        throw new DivergenceError(seq, recorded, name);
      }
      const i = seq;
      seq += 1;
      return i;
    };

    // Cooperative cancellation: every durable op checks the live run status, so
    // a run cancelled mid-flight stops at its next op instead of running on.
    const checkCancelled = async (): Promise<void> => {
      const run = await store.getRun(runId);
      if (run && run.status === 'cancelled') throw new CancelledError(runId);
    };

    // Core step execution: memo, retry, per-attempt timeout/abort, and a
    // post-side-effect cancellation re-check before the result is committed.
    // `claimIndex` and the leading cancel check are done by the callers, so
    // that `all` can reserve all of its child indices up front.
    const executeStep = async <T>(
      name: string,
      index: number,
      fn: (helpers: StepHelpers) => Promise<T> | T,
      opts?: StepOptions,
    ): Promise<T> => {
      const existing = await store.getStep(runId, name);
      if (existing && existing.status === 'completed') {
        return existing.result as T;
      }
      const policy: RetryPolicy = {
        ...defaultStepRetry,
        ...(opts?.retry ?? {}),
      };
      // A timeout means a side effect may still be running; retrying would spawn
      // a second concurrent copy. Do not retry timeouts unless the caller opts
      // in with their own `retryable`.
      if (policy.retryable === undefined) {
        policy.retryable = (err): boolean => !(err instanceof TimeoutError);
      }
      const timeoutMs = opts?.timeoutMs;
      const idempotencyKey = opts?.idempotencyKey ?? `${runId}:${name}`;
      const startedAt = now();
      emit({ type: 'step:start', runId, step: name, index, kind: 'step', attempts: 0, at: startedAt });
      let attemptNo = 0;
      const attempt = (): Promise<T> => {
        attemptNo += 1;
        const controller = new AbortController();
        const helpers: StepHelpers = {
          attempt: attemptNo,
          signal: controller.signal,
          idempotencyKey,
        };
        if (timeoutMs !== undefined) {
          return withTimeout(() => fn(helpers), timeoutMs, name, controller);
        }
        return Promise.resolve(fn(helpers));
      };
      let result: T;
      let attempts: number;
      try {
        ({ result, attempts } = await runWithRetry<T>(attempt, policy, {
          sleep: sleepFn,
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const failedAt = now();
        await store.saveStep({
          runId,
          name,
          index,
          status: 'failed',
          attempts: policy.maxAttempts,
          error: message,
          startedAt,
          finishedAt: failedAt,
        });
        emit({
          type: 'step:fail',
          runId,
          step: name,
          index,
          kind: 'step',
          attempts: policy.maxAttempts,
          at: failedAt,
          durationMs: failedAt - startedAt,
          error: message,
        });
        throw new StepFailedError(name, err);
      }
      // Side effect succeeded. If the run was cancelled while it ran, the
      // cancel wins: do not commit this step as completed.
      await checkCancelled();
      const finishedAt = now();
      await store.saveStep({
        runId,
        name,
        index,
        status: 'completed',
        attempts,
        result,
        startedAt,
        finishedAt,
      });
      emit({
        type: 'step:complete',
        runId,
        step: name,
        index,
        kind: 'step',
        attempts,
        at: finishedAt,
        durationMs: finishedAt - startedAt,
      });
      return result;
    };

    const runStep = async <T>(
      name: string,
      fn: (helpers: StepHelpers) => Promise<T> | T,
      opts?: StepOptions,
    ): Promise<T> => {
      await checkCancelled();
      const index = claimIndex(name);
      return executeStep(name, index, fn, opts);
    };

    let nowSeq = 0;
    let randomSeq = 0;
    let uuidSeq = 0;

    return {
      runId,

      step: runStep,

      async all<T>(
        name: string,
        fns: ReadonlyArray<(helpers: StepHelpers) => Promise<T> | T>,
        opts?: StepOptions,
      ): Promise<T[]> {
        await checkCancelled();
        // Reserve every child's call position synchronously, in array order,
        // before any of them runs. Replay is deterministic regardless of which
        // child settles first.
        const planned = fns.map((fn, i) => {
          const childName = `${name}#${i}`;
          return { childName, fn, index: claimIndex(childName) };
        });
        return Promise.all(
          planned.map((p) => executeStep(p.childName, p.index, p.fn, opts)),
        );
      },

      async sleep(name: string, ms: number): Promise<void> {
        await checkCancelled();
        const index = claimIndex(name);
        const existing = await store.getStep(runId, name);
        if (existing && existing.status === 'completed') return;

        if (durableTimers) {
          const wakeAt = existing?.wakeAt ?? now() + ms;
          if (now() >= wakeAt) {
            await store.saveStep({
              runId,
              name,
              index,
              status: 'completed',
              attempts: 0,
              wakeAt,
              startedAt: existing?.startedAt ?? now(),
              finishedAt: now(),
            });
            return;
          }
          if (!existing) {
            await store.saveStep({
              runId,
              name,
              index,
              status: 'pending',
              attempts: 0,
              wakeAt,
              startedAt: now(),
            });
          }
          throw new PausedError(name);
        }

        // In-process path: block, then mark complete. We deliberately do NOT
        // persist a pending+wakeAt row here. With non-durable timers no
        // supervisor should wake this run, and a stray pending+wakeAt row would
        // make a polling Supervisor/Worker try to resume a run that is still
        // sleeping in-process.
        const startedAt = now();
        await sleepFn(ms);
        await checkCancelled();
        await store.saveStep({
          runId,
          name,
          index,
          status: 'completed',
          attempts: 0,
          startedAt,
          finishedAt: now(),
        });
      },

      async waitForSignal<T>(name: string): Promise<T> {
        await checkCancelled();
        const index = claimIndex(name);
        const existing = await store.getStep(runId, name);
        if (existing && existing.status === 'completed') {
          return existing.result as T;
        }
        const signal = await store.getSignal(runId, name);
        if (signal) {
          await store.saveStep({
            runId,
            name,
            index,
            status: 'completed',
            attempts: 0,
            result: signal.value,
            startedAt: existing?.startedAt ?? now(),
            finishedAt: now(),
          });
          return signal.value as T;
        }
        if (!existing) {
          await store.saveStep({
            runId,
            name,
            index,
            status: 'pending',
            attempts: 0,
            startedAt: now(),
          });
        }
        throw new PausedError(name);
      },

      async llm(name: string, args: LlmArgs): Promise<LlmResult> {
        await checkCancelled();
        const index = claimIndex(name);
        if (!provider) {
          throw new Error(
            'no LLM provider configured; pass one to the Keel constructor',
          );
        }
        const existing = await store.getStep(runId, name);
        if (existing && existing.status === 'completed') {
          return existing.result as LlmResult;
        }
        const startedAt = now();
        emit({ type: 'step:start', runId, step: name, index, kind: 'llm', attempts: 0, at: startedAt });
        try {
          const res = await provider.complete({
            prompt: args.prompt,
            model: args.model,
          });
          const result: LlmResult = {
            text: res.text,
            tokensIn: res.tokensIn,
            tokensOut: res.tokensOut,
            costUsd: res.costUsd,
          };
          await checkCancelled();
          const finishedAt = now();
          await store.saveStep({
            runId,
            name,
            index,
            status: 'completed',
            attempts: 1,
            result,
            tokensIn: res.tokensIn,
            tokensOut: res.tokensOut,
            costUsd: res.costUsd,
            startedAt,
            finishedAt,
          });
          emit({
            type: 'step:complete',
            runId,
            step: name,
            index,
            kind: 'llm',
            attempts: 1,
            at: finishedAt,
            durationMs: finishedAt - startedAt,
          });
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const failedAt = now();
          await store.saveStep({
            runId,
            name,
            index,
            status: 'failed',
            attempts: 1,
            error: message,
            startedAt,
            finishedAt: failedAt,
          });
          emit({
            type: 'step:fail',
            runId,
            step: name,
            index,
            kind: 'llm',
            attempts: 1,
            at: failedAt,
            durationMs: failedAt - startedAt,
            error: message,
          });
          throw new StepFailedError(name, err);
        }
      },

      now(name?: string): Promise<number> {
        const stepName = name ?? `__now#${nowSeq++}`;
        return runStep(stepName, () => now());
      },

      random(name?: string): Promise<number> {
        const stepName = name ?? `__random#${randomSeq++}`;
        return runStep(stepName, () => Math.random());
      },

      uuid(name?: string): Promise<string> {
        const stepName = name ?? `__uuid#${uuidSeq++}`;
        return runStep(stepName, () => randomUUID());
      },
    };
  }
}
