export const CSS = `
:root {
  --ink: #1F1A14;
  --ink-soft: #5d5644;
  --paper: #FEF8F0;
  --panel: #FFFDF9;
  --line: #E3D7C2;
  --line-strong: #C9B898;
  --accent: #485C11;
  --accent-deep: #3A4A0D;
  --accent-ink: #FFFFFF;
  --accent-soft: #EDF1DD;
  --warn: #8A5A12;
  --warn-soft: #F7ECD8;
  --bad: #A23A1A;
  --bad-soft: #F8E7DE;
  --ok: #2E6B34;
  --ok-soft: #E2F0DF;
  --focus: #485C11;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 15px/1.5 "DM Sans", ui-sans-serif, system-ui, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  color: var(--ink);
  background: var(--paper);
}
h1, h2, h3, legend {
  font-family: "Crimson Text", Georgia, "Times New Roman", serif;
  font-weight: 700;
}
a { color: var(--accent); }
a:hover { color: var(--accent-deep); }

.skip { position: absolute; left: -9999px; top: 0; background: var(--accent); color: var(--accent-ink); padding: 0.5rem 1rem; z-index: 10; }
.skip:focus { left: 0; }

header { background: var(--accent); color: var(--accent-ink); padding: 0.75rem 1.25rem; display: flex; gap: 1.25rem; align-items: baseline; flex-wrap: wrap; }
header h1 { font-size: 1.3rem; margin: 0; letter-spacing: 0.01em; }
nav { display: flex; gap: 0.9rem; align-items: center; flex-wrap: wrap; }
nav a { color: var(--accent-ink); text-decoration: none; border-bottom: 1px solid transparent; }
nav a:hover { border-bottom-color: var(--accent-ink); }
nav .who { margin-left: auto; font-size: 0.85rem; opacity: 0.88; }
nav button { border-color: var(--accent-ink); background: transparent; color: var(--accent-ink); padding: 0.2rem 0.6rem; margin: 0; }
nav button:hover { background: var(--accent-deep); }

main { padding: 1rem; max-width: 1100px; margin: 0 auto; }
section.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 1rem 1.25rem;
  margin: 0 0 1rem;
  box-shadow: 0 1px 2px rgba(31, 26, 20, 0.05);
}
h2 { font-size: 1.15rem; margin: 0 0 0.6rem; padding-bottom: 0.45rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 1rem; margin: 0.9rem 0 0.4rem; }

.table-wrap { overflow-x: auto; max-width: 100%; }
table { border-collapse: collapse; width: 100%; min-width: 460px; font-size: 0.9rem; margin: 0.4rem 0; }
caption { text-align: left; font-weight: 600; padding: 4px 0; }
th, td { border: 1px solid var(--line); padding: 0.4rem 0.55rem; text-align: left; vertical-align: top; font-variant-numeric: tabular-nums; }
th { background: #F4ECDC; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-soft); }
table button { margin: 0.15rem 0.15rem 0.15rem 0; padding: 0.3rem 0.6rem; font-size: 0.85rem; }

.chip {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: var(--panel);
  color: var(--ink-soft);
  font-size: 0.75rem;
  font-weight: 700;
  white-space: nowrap;
}
.st-conflict_review, .st-pending_reconciliation, .st-blocked_external, .st-conflict, .st-quarantined {
  color: var(--bad); border-color: var(--bad); background: var(--bad-soft);
}
.st-evidence_gap, .st-awaiting_partner, .st-unbounded, .st-bounded_estimate {
  color: var(--warn); border-color: var(--warn); background: var(--warn-soft);
}
.st-exported, .st-credited, .st-priced, .st-proven, .st-delivered, .st-resolved, .st-accepted {
  color: var(--ok); border-color: var(--ok); background: var(--ok-soft);
}
.st-partially_credited, .st-package_approved, .st-analyst_review, .st-computable, .st-evidence_authorized, .st-authorized, .st-approved {
  color: var(--accent); border-color: var(--accent); background: var(--accent-soft);
}

form.inline { display: inline; }
form fieldset { border: 1px solid var(--line); border-radius: 8px; margin: 0.5rem 0; }
legend { padding: 0 0.4rem; }
label { display: block; font-weight: 600; font-size: 0.9rem; margin: 0.6rem 0 0.15rem; }
input, select, textarea {
  font: inherit;
  width: 100%;
  max-width: 40rem;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  color: var(--ink);
}
input:hover, select:hover, textarea:hover { border-color: var(--line-strong); }
input:focus-visible, select:focus-visible, textarea:focus-visible { border-color: var(--accent); }
textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; }

button {
  font: inherit;
  font-weight: 600;
  padding: 0.5rem 0.9rem;
  margin-top: 0.6rem;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: var(--accent-ink);
  cursor: pointer;
}
button:hover:not(:disabled) { background: var(--accent-deep); }
button.secondary { background: var(--panel); color: var(--accent); }
button.secondary:hover:not(:disabled) { background: var(--accent-soft); }
button.danger { background: var(--bad); border-color: var(--bad); }
button.danger:hover:not(:disabled) { background: #7E2B10; }
button:disabled { opacity: 0.55; cursor: not-allowed; }

:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }

.notice { padding: 0.6rem 1rem; margin: 0.6rem 1rem; border-radius: 6px; border: 1px solid transparent; }
.notice.ok { background: var(--ok-soft); border-color: var(--ok); color: var(--ok); }
.notice.err { background: var(--bad-soft); border-color: var(--bad); border-left-width: 4px; color: var(--bad); }

.kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 4px 16px; }
.kv div { padding: 2px 0; }
.kv dt { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-soft); }
.kv dd { margin: 0; font-weight: 600; }

.totals { display: flex; gap: 1.75rem; flex-wrap: wrap; font-size: 1rem; }
.totals > div { border-left: 3px solid var(--line); padding-left: 0.75rem; }
.totals b { display: block; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-soft); font-weight: 600; }
.totals div:first-child { border-left-color: var(--warn); }
.totals div:last-child { border-left-color: var(--ok); }

.empty { color: var(--ink-soft); font-style: italic; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; word-break: break-all; }
details { margin: 0.4rem 0; }
details summary { cursor: pointer; font-weight: 600; }

@media (max-width: 480px) {
  main { padding: 0.5rem; }
  header { gap: 0.6rem; }
  table { font-size: 0.85rem; }
  .totals { gap: 0.9rem; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;
