import type { CompleteArgs } from './providers/types.js';
import { MockProvider } from './providers/mock.js';
import { Keel } from './runtime.js';
import { MemoryStore } from './store/memory.js';

export interface TestKeelOptions {
  /** Initial value of the controllable clock, in ms. Defaults to 0. */
  startTime?: number;
  /** Canned LLM responder for the MockProvider. Defaults to a fixed string. */
  respond?: (args: CompleteArgs) => string;
  /**
   * Enable durable timers, so `ctx.sleep` suspends and a Supervisor (driven by
   * `advance`) wakes it. Defaults to false, matching a plain in-process engine.
   */
  durableTimers?: boolean;
}

export interface TestKeel {
  keel: Keel;
  store: MemoryStore;
  provider: MockProvider;
  /** Read the controllable clock. */
  now(): number;
  /** Advance the clock by `ms` (drives durable timers and the Supervisor). */
  advance(ms: number): void;
  /** Set the clock to an absolute value in ms. */
  setNow(ms: number): void;
}

/**
 * Build a fully in-memory, deterministic keel engine for tests: a MemoryStore,
 * a MockProvider with a counted call log, instant sleeps, stable run ids, and a
 * controllable clock. This is the "test durable workflows with zero infra"
 * entry point: no database, no broker, no real time, no API keys.
 *
 * ```ts
 * const t = createTestKeel({ respond: () => 'ok' });
 * const r = await t.keel.run(myWorkflow, input);
 * expect(t.provider.calls).toBe(1); // model called exactly once
 * ```
 */
export function createTestKeel(opts: TestKeelOptions = {}): TestKeel {
  let clock = opts.startTime ?? 0;
  const now = (): number => clock;
  const store = new MemoryStore();
  const provider = new MockProvider(opts.respond);
  let counter = 0;
  const keel = new Keel({
    store,
    provider,
    now,
    sleepFn: async () => {},
    idFactory: () => `test_run_${++counter}`,
    durableTimers: opts.durableTimers ?? false,
  });
  return {
    keel,
    store,
    provider,
    now,
    advance: (ms: number): void => {
      clock += ms;
    },
    setNow: (ms: number): void => {
      clock = ms;
    },
  };
}
