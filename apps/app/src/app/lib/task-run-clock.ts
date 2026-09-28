// Task run bookkeeping: sendDraft marks the start, the session.idle / error
// sync event takes it. Also acts as a dedupe guard so terminal events that do
// not correspond to a run this window started (or arrive from a second
// workspace sync) do not fire completion notifications twice.
const taskRunStarts = new Map<string, number>();

export function markTaskRunStart(sessionId: string) {
  if (sessionId.trim()) taskRunStarts.set(sessionId, Date.now());
}

export function takeTaskRunStart(sessionId: string): number | null {
  const startedAt = taskRunStarts.get(sessionId);
  if (startedAt === undefined) return null;
  taskRunStarts.delete(sessionId);
  return startedAt;
}
