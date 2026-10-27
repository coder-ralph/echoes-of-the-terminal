/**
 * Output hygiene for small models: strip markdown and roleplay prefixes,
 * cap length by sentences/characters, and detect "assistant voice" so the
 * scripted ghost can step in when the model breaks character.
 */

const OUT_OF_CHARACTER =
  /\b(as an ai|as a language model|language model|i('| a)?m (just )?an? (ai|assistant)|i cannot|i can'?t (help|assist|do)|i'?m sorry|i apologi[sz]e|sure[,!] here|how can i (help|assist)|here'?s a)\b/i;

const SENTENCE = /[^.!?…]+(?:[.!?…]+|$)["')\]]*\s*/g;

export function cleanStreaming(raw: string): string {
  return raw
    .replace(/\s*\n+\s*/g, " ")
    .replace(/[*_`#]+/g, "")
    .replace(/^\s*(the )?ghost( in the shell)?\s*[:\-]\s*/i, "")
    .replace(/^[\s"“”'‘’]+/, "")
    .replace(/\s{2,}/g, " ");
}

/** Sentences that are *complete* (ended by . ! ? or an ellipsis). */
export function completeSentences(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SENTENCE)) {
    const s = m[0];
    if (/[.!?…]["')\]]*\s*$/.test(s)) out.push(s.trim());
  }
  return out;
}

export function limitSentences(text: string, max: number): string {
  const done = completeSentences(text);
  if (done.length <= max) return text.trimEnd();
  return done.slice(0, max).join(" ");
}

export function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s]+$/, "") + "…";
}

export function isOutOfCharacter(text: string): boolean {
  return OUT_OF_CHARACTER.test(text);
}

/** Final cleanup once the stream ends. Returns null when the output is unusable. */
export function finalizeWhisper(raw: string, maxSentences: number, maxChars: number): string | null {
  let text = cleanStreaming(raw).trim();
  if (!text) return null;
  text = limitSentences(text, maxSentences);
  text = truncateChars(text, maxChars).replace(/["“”]+$/, "").trim();
  if (text.length < 8) return null;
  if (isOutOfCharacter(text)) return null;
  return text;
}
