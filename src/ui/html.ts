import type { Actor } from '../domain/audit.ts';

export function esc(s: unknown): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function money(minor: number | null | undefined, asset: string | null | undefined): string {
  if (minor === null || minor === undefined) return '—';
  return `${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${asset ?? ''}`.trim();
}

export function layout(actor: Actor | null, title: string, body: string, notice?: { kind: string; text: string }): string {
  const nav = actor
    ? `<nav aria-label="Primary"><a href="/">Case queue</a> <a href="/portfolio">Portfolio</a> <a href="/ops">Operations</a>
       <span class="who">${esc(actor.name)} · ${esc(actor.role)}</span>
       <form method="post" action="/ui/logout" class="inline"><button type="submit">Sign out</button></form></nav>`
    : '';
  const live = notice
    ? `<p class="notice ${esc(notice.kind)}" role="status">${esc(notice.text)}</p>`
    : '<p class="notice" role="status" aria-live="polite"></p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Port Evidence Desk</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<header><h1>Port Evidence Desk</h1>${nav}</header>
${live}
<main id="main">
${body}
</main>
</body>
</html>`;
}

export function statusChip(status: string | null | undefined): string {
  const s = String(status ?? 'unknown');
  return `<span class="chip st-${esc(s)}">${esc(s.replaceAll('_', ' '))}</span>`;
}

export interface Col {
  key: string;
  label: string;
  render?: (row: Record<string, unknown>) => string;
}

export function table(caption: string, cols: Col[], rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return `<p class="empty">No rows.</p>`;
  const head = cols.map((c) => `<th scope="col">${esc(c.label)}</th>`).join('');
  const body = rows
    .map(
      (r) =>
        `<tr>${cols.map((c) => `<td>${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`,
    )
    .join('');
  return `<table><caption>${esc(caption)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
