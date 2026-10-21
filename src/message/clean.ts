const AI_NAME = /\b(claude|anthropic|codex|openai|chatgpt|copilot)\b|^(cursor|gemini)( agent| cli)?$/i;
const AI_EMAIL = /noreply@anthropic\.com|@openai\.com|@cursor\.com|noreply@google\.com/i;
const GENERATED = /^[\s\p{Extended_Pictographic}\[\]()*_>-]*generated with\s+\[?(claude|codex|ai)\b/iu;

function isAttributionLine(line: string): boolean {
  const t = line.trim();
  const co = /^co-authored-by\s*:\s*(.*?)\s*(?:<([^>]*)>)?\s*$/i.exec(t);
  if (co) return AI_NAME.test(co[1]) || AI_EMAIL.test(co[2] ?? '');
  if (GENERATED.test(t)) return true;
  if (t.startsWith('🤖')) return true;
  return /^[A-Za-z-]*-Session:/i.test(t);
}

/** Turns raw CLI output into a plain commit message. */
export function cleanMessage(raw: string, stripAttribution: boolean): string {
  let s = raw.replace(/\r\n/g, '\n').trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(s);
  if (fenced) s = fenced[1].trim();
  const q = s[0];
  if (s.length >= 2 && (q === '"' || q === "'" || q === '`') && s[s.length - 1] === q) {
    s = s.slice(1, -1).trim();
  }
  if (stripAttribution) {
    s = s
      .split('\n')
      .filter((l) => !isAttributionLine(l))
      .join('\n');
  }
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
