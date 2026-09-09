/**
 * One LLM call, one schema, one step.
 *
 * There is no agent framework driving control flow here on purpose. The
 * workflow is a plain function in run.ts; this module exists only to run a
 * single prompt and hand back a validated object. If the model returns
 * anything that does not satisfy the schema, the step fails loudly rather
 * than letting malformed reasoning leak downstream.
 */
import { InMemoryRunner, LlmAgent } from '@google/adk';
import type { z } from 'zod';

/** Flash for classification and query writing; Pro for synthesis and adversarial work. */
export const FLASH = process.env.MODEL_FLASH ?? 'gemini-3.7-flash';
export const PRO = process.env.MODEL_PRO ?? 'gemini-3.1-pro-preview';

/** Vertex list price per 1M tokens, used for the cost-per-incident metric. */
const PRICING: Record<string, { input: number; output: number }> = {
  // Google Cloud introductory standard pricing through December 31, 2026.
  'gemini-3.7-flash': { input: 0.75, output: 3.75 },
  // Standard pricing for inputs up to 200K tokens. AdBreak prompts are far below that limit.
  'gemini-3.1-pro-preview': { input: 2, output: 12 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
};

export interface StepUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface StepResult<T> {
  output: T;
  usage: StepUsage;
  raw: string;
}

function costOf(model: string, input: number, output: number): number {
  const p = PRICING[model] ?? PRICING['gemini-3.7-flash'];
  return (input / 1e6) * p.input + (output / 1e6) * p.output;
}

export async function runStep<S extends z.ZodType>(opts: {
  name: string;
  model: string;
  instruction: string;
  input: unknown;
  schema: S;
}): Promise<StepResult<z.infer<S>>> {
  const started = Date.now();
  const agent = new LlmAgent({
    name: opts.name.replace(/[^a-z0-9_]/gi, '_'),
    model: opts.model,
    description: opts.name,
    instruction: opts.instruction,
    outputSchema: opts.schema as never,
  });

  const runner = new InMemoryRunner({ agent });
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of runner.runEphemeral({
    userId: 'adbreak',
    newMessage: { role: 'user', parts: [{ text: JSON.stringify(opts.input, null, 2) }] },
  })) {
    const e = event as unknown as {
      errorCode?: string;
      errorMessage?: string;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      content?: { parts?: { text?: string }[] };
    };
    if (e.errorCode) throw new Error(`${opts.name}: ${e.errorCode} ${e.errorMessage ?? ''}`);
    inputTokens += e.usageMetadata?.promptTokenCount ?? 0;
    outputTokens += e.usageMetadata?.candidatesTokenCount ?? 0;
    for (const part of e.content?.parts ?? []) if (part.text) text += part.text;
  }

  const trimmed = text.trim().replace(/^```(?:json)?/, '').replace(/```$/, '').trim();
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(trimmed);
  } catch {
    throw new Error(`${opts.name}: model did not return JSON: ${trimmed.slice(0, 200)}`);
  }
  const output = opts.schema.parse(parsedJson) as z.infer<S>;

  return {
    output,
    raw: trimmed,
    usage: {
      model: opts.model,
      inputTokens,
      outputTokens,
      costUsd: costOf(opts.model, inputTokens, outputTokens),
      durationMs: Date.now() - started,
    },
  };
}
