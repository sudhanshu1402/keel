import type { WorkflowContext } from './context.js';

export type WorkflowHandler<I, O> = (
  ctx: WorkflowContext,
  input: I,
) => Promise<O>;

export interface WorkflowOptions {
  /**
   * Version of this workflow's logic. Pegged onto each run at creation; a
   * resume whose registered version differs throws `WorkflowVersionError`.
   * Bump it when you change step structure in a way old runs cannot replay.
   * Defaults to 1.
   */
  version?: number;
}

export interface WorkflowDefinition<I = unknown, O = unknown> {
  name: string;
  handler: WorkflowHandler<I, O>;
  version: number;
}

/** Registers a named workflow. The name is used to resume runs by id later. */
export function defineWorkflow<I, O>(
  name: string,
  handler: WorkflowHandler<I, O>,
  opts: WorkflowOptions = {},
): WorkflowDefinition<I, O> {
  return { name, handler, version: opts.version ?? 1 };
}
