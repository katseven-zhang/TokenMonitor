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
- ZCode total and cached tokens matched exactly, while its new event count included 62 zero-usage rows. Its adapter now excludes empty/pending rows consistently with other adapters and clamps negative fields; the ten-source integration fixture covers zero, null and negative rows. Collector revision 3 invalidates old snapshots. Real cache rescan comparison remains pending.
- ccmr, dsh and Pi were not present in configured local paths, so their current evidence is synthetic fixtures. Antigravity has native fixture evidence and real discovery; no numeric parity claim from this JS sample script.

## Runtime issues found and corrected

- Windows accepted TCP sockets inherited the nonblocking listener mode. Delaying a client request by 50–200 ms reproduced connection aborts. Accepted sockets are now explicitly blocking with bounded I/O timeouts; delayed and split request tests pass, and the real packaged service passed delayed status requests plus all three export formats.
- Process existence was insufficient evidence of GUI readiness. Actual window inspection exposed `about:blank`: direct Cargo builds had not enabled Tauri's production `custom-protocol` feature. The default desktop build now enables it, and a release compile guard rejects desktop builds lacking it. Earlier executable sizes must not be described as full GUI package sizes.
- Switching Agent initially displayed the previous query's totals until a new response arrived. Dashboard and request-page responses now require an exact matching query identity; regression tests cover every filter and object key order. Twelve frontend tests and the TypeScript/production build pass; the latest patch still needs native GUI reinspection.

No final completion claim until every remaining acceptance cell has concrete evidence or an explicitly user-approved scope adjustment.
