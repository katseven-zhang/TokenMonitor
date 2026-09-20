# Codex reference migration coverage

Reference: local `codex-usage-desktop-main` v3.3.0. This is a coverage checklist, not a claim of complete parity. The user's pure-local requirement overrides reference features that need online accounts or services.

| Reference area | Desktop implementation | Work still required |
| --- | --- | --- |
| Dashboard hero and usage trends | Total/input/cache/output/reasoning/cost cards; minute ranges; dense empty buckets; bounded aggregation; local cost curve with unknown-price gaps, keyboard-accessible series toggles, expanded dialog and detailed tooltip | Native verification of newly added chart controls; average-per-minute metric already exists |
| Daily and monthly tables | Both groupings, column sorting, pagination and range-intersecting drilldown | Native usability comparison |
| Models and project analytics | Grouped totals and session drilldown; usage/cost shares over all filtered rows, token composition bars, cache hit rate, historical effective unit price and last activity; unknown prices suppress incomplete cost shares | Native verification of added fields; category unit-price comparison with historical-rate context remains to evaluate |
| Session usage and titles | Local titles, text search, session totals, timestamps, sortable columns and 25/50/100-row pagination; native sorting/paging and long-title wrapping verified | Smaller-window and large-source performance checks |
| Conversation replay | Reference parser and modal adapted; messages, tool calls, patches, process continuations and child hierarchy | Real native UI walkthrough; reconcile replay versus queried totals in reset/cumulative cases |
| Subscription limits | Local log observations with timestamps; half-open, archive-deduplicated history and window selector; disclosed 500-observation display cap; native table/filter/empty-state walkthrough passed | Window rollover presentation; never imply live account limits |
| Reset history and credits | Online retrieval/redemption deliberately excluded by user requirements | Show reset history only when supported by actual local observations; distinguish inferred window rollover from explicit reset records |
| Quota forecast | No remote forecast service | Assess which useful metrics can be computed transparently from local observations |
| Model catalog and prices | Offline JSON snapshot, editable rates, aliases and effective dates; searchable saved-price catalog with timestamp selection and historical entries; native search and valid/invalid save checked | Native timestamp/history interaction and inline error follow-up |
| Settings and logs | Local data paths, theme, service port/control, autostart, price editor, logs | Native save/reload/error and tray verification |
| Updates, announcements, account login, remote assets | Excluded from runtime | Final dependency/source audit and dynamic offline checks |

Cross-agent acceptance uses the same minute-range and pricing semantics for all ten sources. Unknown pricing remains unknown; it must not turn into a zero estimate. Detailed evidence and open validation items are tracked in `DESKTOP-VERIFICATION.md`.
