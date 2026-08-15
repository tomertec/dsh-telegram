/**
 * HTML formatting helpers. User/agent content is ALWAYS escaped before it is
 * wrapped, so a message can never inject markup we did not intend.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

export function bold(value: string): string {
  return `<b>${escapeHtml(value)}</b>`;
}

export function code(value: string): string {
  return `<code>${escapeHtml(value)}</code>`;
}

export function link(label: string, href: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

export function plain(value: string): string {
  return escapeHtml(value);
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}\u2026` : value;
}

/**
 * Split a payload into Telegram-safe parts. Newlines are the preferred
 * boundary; an overlong single line is hard-split at the last space within
 * the limit (or exactly at the limit when it has no spaces at all).
 */
export function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) {
      const slice = rest.slice(0, max);
      const space = slice.lastIndexOf(" ");
      cut = space > max / 2 ? space : max;
    } else {
      cut += 1;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}
