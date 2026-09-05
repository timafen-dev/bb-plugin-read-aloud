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
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

/**
 * Split into pieces the route accepts, preferring paragraph then sentence
 * boundaries so a seam lands where a reader would pause anyway.
 */
export function splitForSpeech(text: string, limit: number): string[] {
  if (text.length <= limit) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const seam = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
      window.lastIndexOf("\n"),
    );
    const cut = seam > limit * 0.5 ? seam + 1 : limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  const tail = rest.trim();
  if (tail.length > 0) chunks.push(tail);
  return chunks.filter((chunk) => chunk.length > 0);
}
