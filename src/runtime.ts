import type {
  LlmArgs,
  LlmResult,
  StepOptions,
  WorkflowContext,
} from './context.js';
import { PausedError, StepFailedError } from './errors.js';
import type { Provider } from './providers/types.js';
import { defaultStepRetry, runWithRetry, type RetryPolicy } from './retry.js';
import { MemoryStore } from './store/memory.js';
import type { RunRecord, RunStatus, StepRecord, Store } from './store/types.js';
import type { WorkflowDefinition } from './workflow.js';

export interface KeelOptions {
  store?: Store;
  provider?: Provider;
  /** Override id generation (useful in tests for stable ids). */
  idFactory?: () => string;
  /** Override the delay primitive (tests inject an instant sleep). */
  sleepFn?: (ms: number) => Promise<void>;
  /** Override the clock (tests inject a controllable now). */
  now?: () => number;
}

export interface RunResult<O = unknown> {
  runId: string;
  status: RunStatus;
  output?: O;
  error?: string;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
 */
export class Keel {
  private readonly store: Store;
  private readonly provider?: Provider;
  private readonly idFactory: () => string;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly registry = new Map<string, WorkflowDefinition>();

  constructor(opts: KeelOptions = {}) {
    this.store = opts.store ?? new MemoryStore();
    this.provider = opts.provider;
    this.idFactory = opts.idFactory ?? defaultIdFactory;
    this.sleepFn = opts.sleepFn ?? realSleep;
    this.now = opts.now ?? (() => Date.now());
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
      createdAt: ts,
      updatedAt: ts,
    };
    await this.store.createRun(run);
    return this.execute(def, id, input);
  }

  /** Resume a run by id. The workflow must have been registered (run() does so). */
  async resume<O = unknown>(runId: string): Promise<RunResult<O>> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    const def = this.registry.get(run.workflowName);
    if (!def) {
      throw new Error(
        `workflow ${run.workflowName} is not registered; call register() first`,
      );
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
    const ctx = this.makeContext(runId);
    try {
      const output = await def.handler(ctx, input);
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
      const message = err instanceof Error ? err.message : String(err);
      await this.store.updateRun(runId, {
        status: 'failed',
        error: message,
        updatedAt: this.now(),
      });
      return { runId, status: 'failed', error: message };
    }
  }

  private makeContext(runId: string): WorkflowContext {
    const store = this.store;
    const provider = this.provider;
    const sleepFn = this.sleepFn;
    const now = this.now;

    return {
      runId,

      async step<T>(
        name: string,
        fn: () => Promise<T> | T,
        opts?: StepOptions,
      ): Promise<T> {
        const existing = await store.getStep(runId, name);
        if (existing && existing.status === 'completed') {
          return existing.result as T;
        }
        const policy: RetryPolicy = { ...defaultStepRetry, ...(opts?.retry ?? {}) };
        const startedAt = now();
        try {
          const { result, attempts } = await runWithRetry(fn, policy, {
            sleep: sleepFn,
          });
          await store.saveStep({
            runId,
            name,
            status: 'completed',
            attempts,
            result,
            startedAt,
            finishedAt: now(),
          });
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await store.saveStep({
            runId,
            name,
            status: 'failed',
            attempts: policy.maxAttempts,
            error: message,
            startedAt,
            finishedAt: now(),
          });
          throw new StepFailedError(name, err);
        }
      },

      async sleep(name: string, ms: number): Promise<void> {
        const existing = await store.getStep(runId, name);
        if (existing && existing.status === 'completed') return;
        const startedAt = now();
        if (existing && existing.wakeAt !== undefined) {
          const remaining = existing.wakeAt - now();
          if (remaining > 0) await sleepFn(remaining);
          await store.saveStep({
            ...existing,
            status: 'completed',
            finishedAt: now(),
          });
          return;
        }
        const wakeAt = startedAt + ms;
        await store.saveStep({
          runId,
          name,
          status: 'pending',
          attempts: 0,
          wakeAt,
          startedAt,
        });
        await sleepFn(ms);
        await store.saveStep({
          runId,
          name,
          status: 'completed',
          attempts: 0,
          wakeAt,
          startedAt,
          finishedAt: now(),
        });
      },

      async llm(name: string, args: LlmArgs): Promise<LlmResult> {
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
          await store.saveStep({
            runId,
            name,
            status: 'completed',
            attempts: 1,
            result,
            tokensIn: res.tokensIn,
            tokensOut: res.tokensOut,
            costUsd: res.costUsd,
            startedAt,
            finishedAt: now(),
          });
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await store.saveStep({
            runId,
            name,
            status: 'failed',
            attempts: 1,
            error: message,
            startedAt,
            finishedAt: now(),
          });
          throw new StepFailedError(name, err);
        }
      },
    };
  }
}
