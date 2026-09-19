# Desktop refactor verification ledger

This is an implementation/acceptance record, not a release approval. Branch: `codex/desktop-refactor`.

| Requirement | Current evidence | Remaining acceptance |
| --- | --- | --- |
| New branch, independent work, Room messages only | Branch exists; initial core commit `5765fa1`; Room plan 9309 and subsequent message updates | Continue stage commits and messages |
| Light/dark/system GUI, reference-style layout, no clipped text | Populated native GUI inspected at 1442×992; light/dark toggle works; dark chart contrast corrected in source | Reinspect chart fix, smaller windows and DPI/text scaling |
| Full GUI inside desktop | Corrected production build visibly renders the embedded frontend at tauri.localhost | Final rebuilt package regression |
| User-level service | GUI stop verified with worker exit and cached ZCode queries; autostart toggle writes current-user Run entry and removes it when disabled; delayed/fragmented TCP, auth, stop and port tests | Full GUI port/restart/tray controls and an actual login cycle |
| Every individual Agent with usage details | Ten adapters and shared query/exports; ten-source integration golden totals/minute filters/repeated scans/WAL updates | Review source-specific missing fields and real data coverage |
| Minute precision, 5h/7d | Half-open event queries; boundary tests; actual 5h and 7d RPC queries; date drilldown intersects selected range | GUI entry and drilldown verification |
| Local editable JSON pricing | Timestamp-effective rates, alias validation, explicit unknowns; unit tests and replay-range unknown-price test | GUI save/reload and failed JSON edit verification |
| Pure local, no Node | Loaded native frontend process tree contains TokenMonitor and system WebView2, zero Node processes; a post-render snapshot found zero established TCP connections | Longer observation during active scans/queries and final source audit; a snapshot alone is not proof of permanent offline behavior |
| Codex full detail migration | Attributed reference replay parser/components, tools/patches/process continuation, hierarchy, local quota observation | Feature matrix versus reference UI, local quota history, advanced statistics and usability |
| CSV/Markdown/XLSX | Real 5h exports with identical row counts; CSV and XLSX token sums equal dashboard | Native file dialog and user-facing export flow |
| Small clean overwritten package | Fixed output paths, explicit 6-file whitelist and hash checks; populated production GUI build measured 7,064,576-byte EXE and 4,300,946-byte ZIP | Rebuild and remeasure final changes; prior 5.54 MiB builds were not complete GUI builds |
| Preserve original user work | Old data directory and pre-existing modifications untouched | Final status/commit review |

## Real-source numeric comparison

`node desktop/scripts/compare-local.mjs` runs the existing JS collectors read-only and compares anonymous aggregate samples to the new event cache. It does not output log contents or paths. The JS implementation is a comparison baseline, not the definition of correct behavior.

- Three WorkBuddy samples, three Grok samples, OpenCode and two Claude samples matched event count, total tokens and cached input exactly.
- Three Codex samples differed by 19,329 / 15,431 / 18,498 tokens respectively. Inspection of usage-only fields confirmed each difference was precisely the first usage record. The old collector explicitly discards the first record as a baseline; the new collector includes available first-request usage, matching the intended reference behavior.
- One Claude sample differed by 897 output tokens. The same message/request appears several times with evolving streaming usage. Old first-write-wins storage retains the initial record; new replacement retains the final record. Usage-only inspection confirmed a final-minus-first output delta of 897.
- ZCode total and cached tokens matched exactly, while its new event count included 62 zero-usage rows. Its adapter now excludes empty/pending rows consistently with other adapters and clamps negative fields; the ten-source integration fixture covers zero, null and negative rows. Collector revision 3 invalidates old snapshots. After a real rescan, all three values match: 12,371 records, 4,536,413,817 total tokens and 4,408,719,009 cached tokens.
- ccmr, dsh and Pi were not present in configured local paths, so their current evidence is synthetic fixtures. Antigravity has native fixture evidence and real discovery; no numeric parity claim from this JS sample script.

## Runtime issues found and corrected

- Windows accepted TCP sockets inherited the nonblocking listener mode. Delaying a client request by 50–200 ms reproduced connection aborts. Accepted sockets are now explicitly blocking with bounded I/O timeouts; delayed and split request tests pass, and the real packaged service passed delayed status requests plus all three export formats.
- Process existence was insufficient evidence of GUI readiness. Actual window inspection exposed `about:blank`: direct Cargo builds had not enabled Tauri's production `custom-protocol` feature. The default desktop build now enables it, and a release compile guard rejects desktop builds lacking it. Earlier executable sizes must not be described as full GUI package sizes.
- Switching Agent initially displayed the previous query's totals until a new response arrived. Dashboard and request-page responses now require an exact matching query identity; regression tests cover every filter and object key order. Twelve frontend tests and the TypeScript/production build pass. Native reinspection showed the loading state instead of previous totals, followed by Codex data. The five-hour preset set 01:50–06:50 on 2026-09-20 as expected.

Latest stage commit: `97ba994`. The rebuilt EXE is 7,064,064 bytes and ZIP is 4,301,477 bytes; manifest file hashes/sizes and the six-file ZIP whitelist passed. Dark chart axis labels visibly render with the corrected contrast. These are stage artifacts, not a final release approval.

No final completion claim until every remaining acceptance cell has concrete evidence or an explicitly user-approved scope adjustment.

## Detailed trend and quota history follow-up

- Trends now include empty time buckets across the exact queried range. Tests cover empty periods, summed totals, the exclusive end boundary and bounded bucket counts over very long ranges. Empty usage totals have a known zero cost; missing prices on actual events remain unknown.
- Added local quota observation history with exact start/end boundaries, archive deduplication, optional session scope, newest-first ordering, a disclosed 500-observation display cap and per-window UI filtering. Account-wide observations are explicitly not model/project attribution or real-time balances. No reset-credit action exists.
- Quota normalization tests cover missing values, invalid timestamps, percentages outside the display range and seconds-to-milliseconds conversion. Frontend 14 tests and production build, Rust 36 unit tests plus the ten-source integration test pass.
- Commit `15c54af` rebuilt into the fixed package (EXE 7,071,744 bytes, ZIP 4,304,881 bytes). A real five-hour RPC query returned exactly 300 minute buckets, including 254 empty buckets; summed bucket tokens matched totals, and all 153 observed quota rows were inside the range. Native GUI inspection confirmed visible inactive periods, expandable history columns and window filtering, including an explicit empty state for an unrecorded monthly window. Native select menus required keyboard selection in the automation tool.

## Detail-table and price-catalog follow-up

- Shared model/project/session/day/month tables now support sortable headers and 25/50/100-row pagination. Query changes reset table state, polling preserves it, and pagination never changes aggregate or export scope. Unknown prices remain after known prices in both directions. Tests cover numeric order, unknown-vs-zero pricing, date ordering and deterministic ties.
- Added a searchable saved-JSON model/alias catalog with explicit price-check timestamp, current effective rates and expandable historical entries. The catalog updates only after successful JSON save; draft edits remain distinct from saved pricing.
- Seventeen frontend tests and TypeScript/production build pass. Commit `ee2098c` was rebuilt and inspected in the native GUI: 181 sessions sorted ascending by tokens, long titles wrapped, and pagination advanced from 1–50 to 51–100. The price catalog showed 153 models and searching `gpt-6-astra` reduced it to three matching entries.
- Native negative-price save returned a validation error and the original price-file SHA-256 stayed unchanged. Restoring and saving valid JSON succeeded; parsed prices remained identical after normalizing omitted `effectiveFrom` to the serializer's null value. No model rate was changed by this test. The loaded frontend was refreshed successfully afterward.
- This walkthrough found that save errors were only visible in the top-page banner. Source now also shows the exact save error beside the JSON editor; production frontend build passes. This final small feedback change still needs inclusion in the next native package and visual verification. Small-window/DPI acceptance remains open: an attempted native border drag did not change the window size.

## Duplicate-snapshot and replay consistency follow-up

- Duplicate event/activity snapshots now prefer the latest observation timestamp, then source modification time, then a deterministic path tie-break. A path-first archive no longer shadows a newer streamed update. Both raw copies remain available; replacing one with an empty snapshot can reveal the other. Existing cache views migrate atomically.
- Codex replay now detects a reset when either input or output counters decrease, matching the collector. Replay normalizes nonnegative input/output/cache fields and derives total as input plus output rather than trusting an inconsistent reported total. Zero-total corrections do not become extra usage requests.
- A cross-parser fixture checks first usage, a reset despite increasing combined totals, cache corrections, stale reported totals and duplicate counters. A separate integration test checks partial archives, later downward corrections, cache-view migration and surviving copies. Thirty-seven Rust unit tests plus two integration tests pass; real-package comparison remains pending.
