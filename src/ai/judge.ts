/**
 * Thin seam over the TypeSafe System One client.
 *
 * Everything that asks the model for a judgment goes through `Judge.ask`, so
 * tests can inject a fake and the rest of the pipeline never imports the SDK
 * directly. `createJudge` returns null when no API key is configured — the
 * caller decides whether that is an error (`--layers` without a key) or a
 * silent no-op.
 */
import { TypeSafeClient, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";

export type { Questions } from "@typesafe-ai/sdk";
export { choice, noul, score } from "@typesafe-ai/sdk";

export type Answers<Q extends Questions> = SystemOneResult<Q>["answers"];

export interface Judge {
  /** Evaluate every question in `questions` against `state`, in one request. */
  ask<Q extends Questions>(state: unknown, questions: Q): Promise<Answers<Q>>;
}

export interface JudgeOptions {
  /** Falls back to `TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** Falls back to `TYPESAFE_DEFAULT_MODEL`, then the SDK default (`jev-latest`). */
  model?: string;
  /** Per-attempt timeout in ms. Indexing is batch work; be generous. */
  timeoutMs?: number;
}

export function createJudge(opts: JudgeOptions = {}): Judge | null {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) return null;
  const client = new TypeSafeClient({
    apiKey,
    defaultModel: opts.model,
    timeout: opts.timeoutMs ?? 30_000,
    logLevel: "warn",
  });
  return {
    async ask(state, questions) {
      const result = await client.systemOne({
        state: state as Parameters<typeof client.systemOne>[0]["state"],
        questions,
      });
      return result.answers;
    },
  };
}
