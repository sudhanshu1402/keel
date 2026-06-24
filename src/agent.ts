import type { LlmResult, WorkflowContext } from './context.js';
import { defineWorkflow, type WorkflowDefinition } from './workflow.js';

/**
 * A tool the agent can call. `run` receives the parsed args the model emitted
 * and returns a JSON-serializable result. Each call is wrapped in `ctx.step`,
 * so a tool that has already run is replayed from the store on resume instead
 * of executing again.
 */
export interface AgentTool<A = any, R = any> {
  name: string;
  description: string;
  run: (args: A) => Promise<R> | R;
  /**
   * Optional argument guard. Return an error string to reject the model's args
   * (the rejection is fed back as an observation and the tool is not run);
   * return undefined to accept. Keeps a hallucinated argument shape from
   * reaching `run`.
   */
  validateArgs?: (args: unknown) => string | undefined;
}

export interface AgentInput {
  prompt: string;
}

export interface AgentToolCall {
  tool: string;
  args: unknown;
  result: unknown;
}

/**
 * Why the loop stopped. `final`: the model produced a final answer.
 * `max_turns`: the turn cap was hit first. `budget`: a token or cost ceiling
 * was reached. Only `final` means the answer is the model's intended result.
 */
export type AgentStopReason = 'final' | 'max_turns' | 'budget';

export interface AgentResult {
  answer: string;
  turns: number;
  toolCalls: AgentToolCall[];
  stopReason: AgentStopReason;
}

export interface DurableAgentOptions {
  tools?: AgentTool[];
  /** Hard cap on model/tool turns before the loop gives up. Defaults to 8. */
  maxTurns?: number;
  /** Extra system guidance prepended to every turn's prompt. */
  system?: string;
  /** Model name passed through to the provider on each turn. */
  model?: string;
  /** Stop once cumulative LLM cost reaches this many USD. */
  maxCostUsd?: number;
  /** Stop once cumulative tokens (in + out) reach this. */
  maxTokens?: number;
  /**
   * Include only the most recent N tool observations in each prompt, to bound
   * prompt growth on long loops. Defaults to all of them.
   */
  historyWindow?: number;
}

type Action =
  | { kind: 'tool'; tool: string; args: unknown }
  | { kind: 'final'; answer: string }
  | { kind: 'malformed'; reason: string };

const PROTOCOL = `You are a tool-using agent. On each turn reply with EXACTLY ONE JSON object and nothing else, in one of these two forms:
  {"tool": "<toolName>", "args": { ... }}   to call a tool
  {"final": "<answer>"}                       when you have the final answer
Only use the tools listed below. Do not invent tools. Do not combine both forms in one reply.`;

/**
 * Extract the first complete, balanced JSON object from `text`, respecting
 * string literals and escapes so a brace inside a string does not throw off the
 * scan. Returns the object's source, or undefined if there is no balanced
 * object.
 */
function balancedObject(s: string): string | undefined {
  const start = s.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1]!.trim() : trimmed;
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(candidate);
  if (direct !== undefined) return direct;
  const obj = balancedObject(candidate);
  if (obj !== undefined) return tryParse(obj);
  return undefined;
}

function parseAction(text: string): Action {
  const obj = extractJson(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { kind: 'malformed', reason: 'reply was not a single JSON object' };
  }
  const o = obj as Record<string, unknown>;
  const hasTool = typeof o.tool === 'string';
  const hasFinal = 'final' in o;
  // Ambiguous: the protocol allows exactly one form. Refuse to guess which the
  // model meant; ask it to pick one.
  if (hasTool && hasFinal) {
    return {
      kind: 'malformed',
      reason: 'reply contained both "tool" and "final"; emit exactly one',
    };
  }
  if (hasTool) {
    return { kind: 'tool', tool: o.tool as string, args: o.args ?? {} };
  }
  if (hasFinal) {
    const f = o.final;
    return {
      kind: 'final',
      answer: typeof f === 'string' ? f : JSON.stringify(f),
    };
  }
  return {
    kind: 'malformed',
    reason: 'reply had neither a "tool" nor a "final" field',
  };
}

function buildPrompt(
  opts: DurableAgentOptions,
  task: string,
  history: AgentToolCall[],
): string {
  const toolList =
    (opts.tools ?? []).map((t) => `- ${t.name}: ${t.description}`).join('\n') ||
    '(no tools available)';
  const lines: string[] = [PROTOCOL];
  if (opts.system) lines.push('', opts.system);
  lines.push('', 'Tools:', toolList, '', `Task: ${task}`);
  const window =
    opts.historyWindow !== undefined
      ? history.slice(-opts.historyWindow)
      : history;
  if (window.length > 0) {
    lines.push('', 'Progress so far:');
    for (const h of window) {
      lines.push(
        `- ${h.tool}(${JSON.stringify(h.args)}) -> ${JSON.stringify(h.result)}`,
      );
    }
  }
  lines.push('', 'Respond with the next JSON action.');
  return lines.join('\n');
}

/**
 * Run a durable, multi-turn tool loop inside an existing workflow context.
 * Every model call is a `ctx.llm` and every tool call is a `ctx.step`, both
 * keyed by turn number, so the whole loop is memoized and resumable: a crash
 * mid-loop replays prior turns from the store without re-calling the model.
 *
 * The loop always terminates: at a final answer (`stopReason: 'final'`), at the
 * turn cap (`'max_turns'`), or when a token/cost ceiling is hit (`'budget'`).
 * Inspect `stopReason` rather than assuming `answer` is a real answer.
 */
export async function runAgentLoop(
  ctx: WorkflowContext,
  input: AgentInput,
  opts: DurableAgentOptions = {},
): Promise<AgentResult> {
  const tools = new Map((opts.tools ?? []).map((t) => [t.name, t] as const));
  const maxTurns = opts.maxTurns ?? 8;
  const toolCalls: AgentToolCall[] = [];
  let lastObservation = '';
  let totalTokens = 0;
  let totalCost = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const prompt = buildPrompt(opts, input.prompt, toolCalls);
    const res: LlmResult = await ctx.llm(`turn-${turn}`, {
      prompt,
      ...(opts.model ? { model: opts.model } : {}),
    });
    totalTokens += res.tokensIn + res.tokensOut;
    totalCost += res.costUsd ?? 0;
    const action = parseAction(res.text);

    if (action.kind === 'final') {
      return { answer: action.answer, turns: turn, toolCalls, stopReason: 'final' };
    }

    if (action.kind === 'malformed') {
      // Do NOT coerce a malformed reply into a final answer. Feed the parse
      // error back as an observation and consume the turn. Deterministic on
      // replay: the memoized model text parses the same way every time.
      toolCalls.push({
        tool: '(invalid)',
        args: res.text,
        result: { error: action.reason },
      });
      lastObservation = action.reason;
    } else {
      const tool = tools.get(action.tool);
      if (!tool) {
        toolCalls.push({
          tool: action.tool,
          args: action.args,
          result: { error: `unknown tool "${action.tool}"` },
        });
        lastObservation = `unknown tool "${action.tool}"`;
      } else {
        const validationError = tool.validateArgs?.(action.args);
        if (validationError !== undefined) {
          toolCalls.push({
            tool: action.tool,
            args: action.args,
            result: { error: `invalid args: ${validationError}` },
          });
          lastObservation = `invalid args: ${validationError}`;
        } else {
          const result = await ctx.step(`tool-${turn}`, () =>
            tool.run(action.args),
          );
          toolCalls.push({ tool: action.tool, args: action.args, result });
          lastObservation = JSON.stringify(result);
        }
      }
    }

    if (opts.maxCostUsd !== undefined && totalCost >= opts.maxCostUsd) {
      return {
        answer: lastObservation || 'stopped: cost budget reached',
        turns: turn,
        toolCalls,
        stopReason: 'budget',
      };
    }
    if (opts.maxTokens !== undefined && totalTokens >= opts.maxTokens) {
      return {
        answer: lastObservation || 'stopped: token budget reached',
        turns: turn,
        toolCalls,
        stopReason: 'budget',
      };
    }
  }

  return {
    answer: lastObservation || 'max turns reached without a final answer',
    turns: maxTurns,
    toolCalls,
    stopReason: 'max_turns',
  };
}

/**
 * Wrap an agent loop as a registrable workflow. Run it with
 * `keel.run(agent, { prompt })` and it gains durability, retries, and resume
 * for free, like any other keel workflow.
 */
export function defineAgent(
  name: string,
  opts: DurableAgentOptions = {},
): WorkflowDefinition<AgentInput, AgentResult> {
  return defineWorkflow<AgentInput, AgentResult>(name, (ctx, input) =>
    runAgentLoop(ctx, input, opts),
  );
}
