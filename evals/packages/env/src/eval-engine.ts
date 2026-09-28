import { resolveEvalEngineValue } from "@harness/hosts/eval-engine";
import type { EvalEngine } from "@harness/hosts/eval-engine";

export type { EvalEngine } from "@harness/hosts/eval-engine";

export function resolveEvalEngine(env: NodeJS.ProcessEnv = process.env): EvalEngine {
  return resolveEvalEngineValue(env.HARNESS_EVAL_ENGINE);
}
