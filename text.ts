/**
 * Turning message text into something worth hearing.
 *
 * Kept free of plugin-contract imports so it can be tested on its own — the
 * same reason `sources/github-environment.ts` exists in other BB plugins.
 */

/**
 * Strip what reads badly aloud while keeping every word. Fenced code is
 * dropped outright — a voice reading YAML helps nobody.
 */
export function speakableText(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s{0,3}>\s?/gmu, "")
    .replace(/^\s{0,3}[-*+]\s+/gmu, "")
    .replace(/(\*\*|__)(.*?)\1/gu, "$2")
    .replace(/(\*|_)(.*?)\1/gu, "$2")
    .replace(/^\s*\|.*\|\s*$/gmu, " ")
    .replace(/^\s*[-:|\s]+$/gmu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

/**
 * Light, safe normalization only. Anything cleverer — stress marks, dates,
 * money — waits until a real message is heard to go wrong, per the plan.
 */
export function normalizeForSpeech(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gu, "ссылка")
    .replace(/(?:^|\s)(?:[\w.-]*\/)+([\w.-]+\.\w{1,6})\b/gu, " файл $1")
    .replace(/\b[0-9a-f]{7,40}\b/gu, "версия")
    .replace(/([!?.,:;—-])\1{1,}/gu, "$1")
    // A message that already said "файл src/main.py" would otherwise be read
    // as "файл файл main.py": the substitution repeats a word the author wrote.
    // Only the words this function inserts are collapsed — a genuine "очень
    // очень" in someone's prose is theirs to keep. JavaScript's \b is
    // ASCII-only, so the boundaries are spelled out instead.
    .replace(
      /(^|[^\p{L}])(ссылка|файл|версия)(?:\s+\2)+(?![\p{L}])/giu,
      "$1$2",
    )
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

/**
 * How long each piece may be, in order. The last entry repeats.
 *
 * Synthesis costs time in proportion to the text, while the audio it produces
 * plays for ten times longer — so a short first piece starts the voice almost
 * at once and the queue is never caught up with afterwards. Measured on an
 * ordinary loaded machine: 180 characters take about half a second and play
 * for eight, 1500 take five seconds and play for eighty.
 */
export const CHUNK_SIZE_RAMP = [180, 420, 900, 1500] as const;

function limitFor(sizes: readonly number[], index: number): number {
  return sizes[Math.min(index, sizes.length - 1)]!;
}

/**
 * Split into pieces the route accepts, preferring paragraph then sentence
 * boundaries so a seam lands where a reader would pause anyway.
 */
export function splitForSpeech(
  text: string,
  sizes: readonly number[],
): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > 0) {
    const limit = limitFor(sizes, chunks.length);
    if (rest.length <= limit) {
      chunks.push(rest);
      break;
    }
    const window = rest.slice(0, limit);
    const seam = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
      window.lastIndexOf("\n"),
    );
    const cut = seam > limit * 0.5 ? seam + 1 : limit;
    const piece = rest.slice(0, cut).trim();
    if (piece.length > 0) chunks.push(piece);
    rest = rest.slice(cut).trim();
  }
  return chunks;
}


/** Where an interrupted reading left off. */
export interface PausedAt {
  messageId: string;
  chunks: string[];
  index: number;
  /** Seconds into `chunks[index]`. */
  offset: number;
  threadId: string;
  format: string;
}

/**
 * Decide whether pressing ▶ continues an interrupted reading or starts over.
 *
 * Continuing is only right when it is the same message, read the same way. A
 * highlighted selection is a different thing to read, and a different audio
 * format means the remembered offset belongs to audio we are not about to
 * play, so both start from the beginning.
 */
export function resumePoint(
  paused: PausedAt | null,
  messageId: string,
  selection: string,
  format: string,
): { index: number; offset: number; chunks: string[] } | null {
  if (paused === null) return null;
  if (paused.messageId !== messageId) return null;
  if (selection.trim().length > 0) return null;
  if (paused.format !== format) return null;
  if (paused.index < 0 || paused.index >= paused.chunks.length) return null;
  return {
    index: paused.index,
    offset: Math.max(0, paused.offset),
    chunks: paused.chunks,
  };
}
