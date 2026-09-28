// Local, in-process observer for unhandled server errors. Nothing here
// leaves the machine: Harness ships no crash reporter or telemetry sink.
// Tests install an observer to assert which failures count as unhandled.
export type UnhandledErrorContext = {
  method?: string;
  route?: string;
  surface?: string;
  /** Used only to recognise expected cancellations; never passed to the observer. */
  requestSignal?: AbortSignal;
};

export type HarnessUnhandledErrorObserver = {
  captureException: (error: unknown, context?: UnhandledErrorContext) => boolean;
};

declare global {
  // Unset in production; tests install one to observe unhandled errors.
  var __harnessUnhandledErrorObserver: HarnessUnhandledErrorObserver | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isExpectedRequestCancellation(error: unknown, requestSignal: AbortSignal | undefined): boolean {
  if (!requestSignal?.aborted) return false;
  // Abort reasons may legally be null (including a canceled empty HEAD body).
  if (error === requestSignal.reason) return true;
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && current !== undefined; depth += 1) {
    if (current === requestSignal.reason) return true;
    if (!isRecord(current) || visited.has(current)) return false;
    visited.add(current);
    if (current.name === "AbortError") return true;
    if (
      current.code === "ABORT_ERR" ||
      current.code === "ECONNRESET" ||
      current.code === "ERR_STREAM_PREMATURE_CLOSE" ||
      current.code === "UND_ERR_SOCKET"
    ) return true;
    const message = current.message;
    if (typeof message === "string" && /^(?:The operation was )?aborted\.?$|^terminated$/i.test(message)) return true;
    current = current.cause;
  }
  return false;
}

export function reportUnhandledServerError(error: unknown, context: UnhandledErrorContext = {}): boolean {
  const { requestSignal, ...observerContext } = context;
  if (isExpectedRequestCancellation(error, requestSignal)) return false;
  return globalThis.__harnessUnhandledErrorObserver?.captureException(error, {
    surface: "server",
    ...observerContext,
  }) ?? false;
}
