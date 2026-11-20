# Port Evidence Desk · Master build prompt

Build Port Evidence Desk in the repository supplied with this pack. The product's first complete journey is the following.

Import the invoice and select its governing tariff. Inspect which trip events are proven, disputed or absent. See the possible charge range and the partner's quote for the missing event. Set a cap, authorize retrieval, review the normalized timeline and export a versioned claim. Accounts records a credit only when the carrier issues it.

## Intake

Read repository instructions and inspect the current branch, HEAD, uncommitted work, existing architecture, locked dependencies, test commands and any ongoing implementation. Check [source baselines](SOURCES.md) before reusing upstream work. Record whether this is a dedicated greenfield project or an extension. For an existing implementation, trace each claimed capability from its real entry point before assigning completion. Preserve user changes.

## Build

Follow [the module index](MODULES.md). Drive changes from observable failing behavior. Implement actual domain rules, authorization, UI/API, storage and recovery. Use test doubles for deterministic fault injection and pair them with real local integration tests. Keep independent work moving when a partner dependency blocks one path. Expose each blocked external feature honestly in the UI and status ledger.

## Evidence and exit

Example configured terminal tariff in INR uses local calendar dates, a discharge date of May 1 as free day one, May 2 as free day two, then INR 1,000/day including gate-out date. Carrier bills INR 3,000. Gate-out could be May 4 or 5, so expected charge is INR 2,000–3,000 and potential dispute INR 0–1,000. Under a manager-approved INR 200 evidence ceiling and an explicit policy permitting investigation of that range, a quote of INR 150 is eligible. An authorized May 4 record fixes the variance at INR 1,000. A later carrier credit of INR 700 records actual recovery of INR 700; without the credit recovery is zero. If the evidence quote is denominated in another asset, require a pinned conversion within its validity window or block authorization.

Show the normal workflow in a clean checkout, exercise failure and restart, and leave evidence tied to the exact tested revision. A recorded demo uses the running product and permitted inputs. Verify logs, screenshots and exports are redacted. Local building and testing begin when the owner invokes this prompt for the supplied target. Remote publishing, deployment, paid calls, account creation, signing and public submissions need action-specific authority. Use the owner’s existing grants when applicable.

After every module, and before yielding, update the [continuation records](DELIVERY.md). Tell the next agent what already works, what failed, the last command, and the first concrete operation to perform.
