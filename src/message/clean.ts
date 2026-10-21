const AI_NAMES = /claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor/i;

function isAttributionLine(line: string): boolean {
  const t = line.trim();
  if (/^co-authored-by\s*:/i.test(t)) return AI_NAMES.test(t);
  if (/generated with/i.test(t) && (AI_NAMES.test(t) || /\bai\b/i.test(t))) return true;
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
