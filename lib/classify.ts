import type { EditMagnitude, WikiEditEvent } from "./types";

export function classifyMagnitude(
  sizeDelta: number,
  isRevert: boolean
): EditMagnitude {
  if (isRevert || Math.abs(sizeDelta) >= 5000) return "LARGE";
  if (Math.abs(sizeDelta) >= 501) return "MEDIUM";
  if (Math.abs(sizeDelta) >= 51) return "SMALL";
  return "TINY";
}

export function normalizeEvent(raw: Record<string, unknown>): WikiEditEvent | null {
  try {
    const meta = raw.meta as Record<string, unknown> | undefined;
    const id = String(meta?.id ?? raw.id ?? Math.random());
    const title = String(raw.title ?? "");
    const lengthObj = raw.length as Record<string, unknown> | undefined;
    const newLen = Number(lengthObj?.new ?? 0);
    const oldLen = Number(lengthObj?.old ?? 0);
    const sizeDelta = newLen - oldLen;
    const isBot = Boolean(raw.bot);
    const comment = String(raw.comment ?? "");
    const isRevert =
      Boolean(raw.reverted) ||
      comment.toLowerCase().includes("revert") ||
      comment.toLowerCase().includes("undo");
    const timestamp = Number(raw.timestamp ?? Date.now() / 1000) * 1000;
    const magnitude = classifyMagnitude(sizeDelta, isRevert);

    return { id, title, sizeDelta, isBot, isRevert, timestamp, magnitude };
  } catch {
    return null;
  }
}
