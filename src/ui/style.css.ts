export const CSS = `
:root { color-scheme: light; --ink:#1b2430; --line:#c9d2dd; --bg:#f6f8fa; --card:#fff; --accent:#0b5394; }
* { box-sizing: border-box; }
body { margin:0; font:15px/1.45 system-ui, sans-serif; color:var(--ink); background:var(--bg); }
.skip { position:absolute; left:-999px; }
.skip:focus { left:8px; top:8px; z-index:9; background:#fff; padding:6px; }
header { background:var(--card); border-bottom:1px solid var(--line); padding:10px 16px; display:flex; gap:18px; align-items:baseline; flex-wrap:wrap; }
header h1 { font-size:18px; margin:0; }
nav { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
nav .who { margin-left:auto; color:#555; }
main { padding:16px; max-width:1100px; margin:0 auto; }
section.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin:12px 0; }
h2 { font-size:16px; margin:0 0 8px; }
h3 { font-size:14px; margin:12px 0 6px; }
.table-wrap { overflow-x:auto; max-width:100%; }
table { border-collapse:collapse; width:100%; min-width:460px; font-size:14px; margin:6px 0; }
caption { text-align:left; font-weight:600; padding:4px 0; }
th, td { border:1px solid var(--line); padding:5px 8px; text-align:left; vertical-align:top; }
th { background:#eef2f6; }
.chip { display:inline-block; padding:1px 8px; border-radius:10px; border:1px solid var(--line); background:#eef2f6; font-size:12px; white-space:nowrap; }
.st-conflict_review, .st-pending_reconciliation, .st-blocked_external, .st-conflict, .st-quarantined { background:#fde8e8; border-color:#e0a0a0; }
.st-evidence_gap, .st-awaiting_partner, .st-unbounded, .st-bounded_estimate { background:#fff4d6; border-color:#d9b44a; }
.st-exported, .st-credited, .st-priced, .st-proven, .st-delivered, .st-resolved, .st-accepted { background:#e0f2e2; border-color:#8fc796; }
.st-partially_credited, .st-package_approved, .st-analyst_review, .st-computable, .st-evidence_authorized, .st-authorized, .st-approved { background:#e2ecfb; border-color:#93b4e0; }
form.inline { display:inline; }
form fieldset { border:1px solid var(--line); border-radius:6px; margin:8px 0; }
label { display:block; margin:6px 0 2px; font-size:13px; }
input, select, textarea { font:inherit; padding:5px 7px; border:1px solid var(--line); border-radius:4px; max-width:100%; }
button { font:inherit; padding:6px 12px; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:4px; cursor:pointer; }
button.secondary { background:#fff; color:var(--accent); }
button.danger { background:#a03030; border-color:#a03030; }
:focus-visible { outline:3px solid #ffbf47; outline-offset:1px; }
.notice { padding:8px 12px; margin:10px 16px; border-radius:6px; }
.notice.ok { background:#e0f2e2; }
.notice.err { background:#fde8e8; }
.kv { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:4px 16px; }
.kv div { padding:2px 0; }
.kv dt { font-size:12px; color:#555; }
.kv dd { margin:0; font-weight:600; }
.totals { display:flex; gap:24px; flex-wrap:wrap; font-size:15px; }
.totals b { display:block; font-size:12px; font-weight:600; color:#555; }
.empty { color:#666; font-style:italic; }
.mono { font-family:ui-monospace, monospace; font-size:12px; word-break:break-all; }
details { margin:6px 0; }
@media (max-width:480px) { main { padding:8px; } table { font-size:13px; } }
@media (prefers-reduced-motion: reduce) { * { transition:none !important; animation:none !important; } }
`;
