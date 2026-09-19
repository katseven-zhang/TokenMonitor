# Codex reference migration coverage

Reference: local `codex-usage-desktop-main` v3.3.0. This is a coverage checklist, not a claim of complete parity. The user's pure-local requirement overrides reference features that need online accounts or services.

| Reference area | Desktop implementation | Work still required |
| --- | --- | --- |
| Dashboard hero and usage trends | Total/input/cache/output/reasoning/cost cards and native charts; selectable minute ranges | Preserve inactive time buckets; compare detailed trend interactions and pace statistics |
| Daily and monthly tables | Both groupings and range-intersecting drilldown | Column sorting and native usability comparison |
| Models and project analytics | Grouped totals, price completeness and drilldown into sessions | Compare distribution/detail fields with reference components |
| Session usage and titles | Local titles, text search, session totals and timestamps | Large-table paging/sorting and title overflow checks |
| Conversation replay | Reference parser and modal adapted; messages, tool calls, patches, process continuations and child hierarchy | Real native UI walkthrough; reconcile replay versus queried totals in reset/cumulative cases |
| Subscription limits | Local log observations only, with observation timestamp | Local observation history and window rollover presentation; never imply live account limits |
| Reset history and credits | Online retrieval/redemption deliberately excluded by user requirements | Show reset history only when supported by actual local observations; distinguish inferred window rollover from explicit reset records |
| Quota forecast | No remote forecast service | Assess which useful metrics can be computed transparently from local observations |
| Model catalog and prices | Offline JSON snapshot, editable rates, aliases and effective dates | Searchable local catalog and clear active/historical price presentation |
| Settings and logs | Local data paths, theme, service port/control, autostart, price editor, logs | Native save/reload/error and tray verification |
| Updates, announcements, account login, remote assets | Excluded from runtime | Final dependency/source audit and dynamic offline checks |

Cross-agent acceptance uses the same minute-range and pricing semantics for all ten sources. Unknown pricing remains unknown; it must not turn into a zero estimate. Detailed evidence and open validation items are tracked in `DESKTOP-VERIFICATION.md`.
