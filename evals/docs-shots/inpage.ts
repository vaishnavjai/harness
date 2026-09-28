import { browserScript } from "@harness/cdp";
import { evalIn } from "@harness/behaviors";
import type { Surface, EvaluateOptions } from "@harness/cdp";
export type InPageOptions = EvaluateOptions;

/** Execute a checked browser callback with one explicit argument. */
export function inPage<A, R>(surface: Surface, callback: (args: A) => R, args: A, options: InPageOptions = {}): Promise<Awaited<R>> {
  return evalIn(surface, browserScript(callback, [args]), options);
}
