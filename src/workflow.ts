import type { WorkflowContext } from './context.js';

export type WorkflowHandler<I, O> = (
  ctx: WorkflowContext,
  input: I,
) => Promise<O>;

export interface WorkflowDefinition<I = unknown, O = unknown> {
  name: string;
  handler: WorkflowHandler<I, O>;
}

/** Registers a named workflow. The name is used to resume runs by id later. */
export function defineWorkflow<I, O>(
  name: string,
  handler: WorkflowHandler<I, O>,
): WorkflowDefinition<I, O> {
  return { name, handler };
}
