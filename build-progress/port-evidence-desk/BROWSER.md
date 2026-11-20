# Browser journey check

Verifies the documented operator journey against the real running UI:
sign in → case queue → seeded container invoice (INV-7741 / MSCU1234567 /
VOY-88) → gate-out evidence + day ledger → disputed vs confirmed recovery →
portfolio → keyboard accessibility + focus visibility → 320 CSS px → reload
persistence → permission/error visibility.

## Run

```sh
# Full check — real Chromium over CDP (preferred):
node tools/browser-check.mjs

# Explicit binary (any Chrome/Edge/headless-shell with --remote-debugging-port):
PED_BROWSER="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell" \
  node tools/browser-check.mjs

# HTTP-level fallback when no browser can launch (marks layout/keyboard
# checks skipped instead of passing them):
PED_BROWSER=none node tools/browser-check.mjs
```

## Dependencies

- Node.js ≥ 22 (built-in `WebSocket` client + `fetch`; no npm packages needed
  for the check itself).
- The app (`npm ci` once for the `typescript` dev dependency used by
  `npm run typecheck`; the server itself needs no dependencies).
- A Chromium-family binary **only** for the CDP mode. Default discovery:
  `~/Library/Caches/ms-playwright/chromium_headless_shell-1254/...` —
  override with `PED_BROWSER`.

## Behaviour

- Ephemeral everything: the app binds a free loopback port, CDP binds
  another, and database/export/browser-profile state lives in a disposable
  `var/browser-check-*` dir that is removed on exit (`PED_KEEP_WORKDIR=1`
  keeps it).
- Data is seeded through the normal JSON API; the journey itself is driven
  through the rendered pages — Tab/Enter via real CDP key events in browser
  mode, real form POSTs in both modes.
- Writes a redacted evidence record to
  `build-progress/port-evidence-desk/evidence/browser-<ts>.json` (check names,
  pass/fail/skipped, no credentials). A completed run from this repo is at
  `evidence/html-journey.json` (24 pass / 0 fail / 5 skipped, HTML mode).
- Exit 0 = all executed checks passed · 1 = a check failed · 2 = the browser
  could not launch in this environment (prints the host replay command).

## Environment status

Browser launch is **blocked inside this agent's sandbox** (macOS Mach
bootstrap policy, not a product defect):

```
FATAL:base/apple/mach_port_rendezvous_mac.cc:159 Check failed:
bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer:
Permission denied (1100)
```

The CDP-mode checks that only a real layout engine can prove — Tab focus
order, focus-ring rendering, Enter activation, 320 px overflow, keyboard
traversal at 320 px — are therefore recorded **skipped**, not passed, in the
local evidence. Replaying `node tools/browser-check.mjs` on the host upgrades
them to real proof with no code changes.

## Gates kept separate

- `local_demo` evidence rail only — a team-controlled fake merchant; the
  check never touches `kite_session` (which stays fail-closed) or any real
  provider/payment.
- Demo sign-ins are seeded locally; PINs exist only inside the sandboxed run
  and are never written to evidence.
- No external network: the app, browser and all fetches are loopback-only.
