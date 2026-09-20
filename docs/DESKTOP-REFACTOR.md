# TokenMonitor 2 desktop refactor

Branch: `codex/desktop-refactor`. Independent development; Room messages only.

## Accepted requirements

- Tauri + React + native Rust; no Node in distribution. Complete GUI inside desktop.
- Light (default), dark, system themes; legible Chinese and long labels, DPI validation.
- User-level background service: start/stop/restart from the GUI, configurable loopback port, tray residence and current-user login startup, without administrator privileges. This is the user's confirmed service mode.
- Pure local runtime: no telemetry, network pricing, account requests, reset actions, updater, remote fonts/images.
- Minute-precise half-open `[start, end)` time selection for every agent, rolling 5h and 7d presets.
- Select all or any individual agent, then overview/model/project/day/month/session/request/tool details.
- Local editable JSON model pricing; explicit unknown prices, cache read/write, time-effective rates.
- No old test database compatibility. Rebuild a timestamped event cache from read-only source files.
- Reference Codex UI and full replay (messages, tools, patches, child agents) retained and adapted.
- All ten current sources supported, including archive and newer Codex event formats.
- Export selected data; fixed overwritten build outputs, no user data in packages.

## Source attribution

Reference: local `codex-usage-desktop-main` 3.3.0, https://github.com/itvincent-git/codex-usage-desktop .
Copied/adapted replay parser, replay React components, formatting helpers, types, locales, and styling configuration retain the license in `desktop/LICENSE.codex-usage-desktop` (Copyright 2026 vincent).
No reference updater or account credentials are reused.

## Verification gates (implementation and acceptance)

- [x] Native event collectors for 10 sources; fixed source fixtures and dedup/restart verification.
- [x] Range boundary, cache token accounting, historical JSON pricing and unknown model checks.
- [ ] Every agent independently filtered across every detail and export.
- [x] Codex full replay and hierarchy verified with fixtures and real GUI.
- [x] Service lifecycle, port collisions, single instance, stopped-service cached queries.
- [ ] GUI theme/layout/DPI inspection, exports, settings persistence.
- [x] No external requests: source audit plus bounded running-process TCP observation (not a permanent network guarantee).
- [x] Release build, no-Node execution, size report, fixed overwrite packaging.

Old worktree edits (.gitignore and two untracked review/plan documents) are pre-existing and not refactor work.

## Current verification evidence (2026-09-20, work in progress)

- Branch created; complete planning message posted to Room as 9309, implementation updates via messages only.
- User confirmed user-level service: GUI controls, configurable port, tray residence and login startup, without administrator privileges.
- Frontend production build and 27 frontend tests pass. Native tests: 37 unit tests plus three integration tests pass, including all 10 adapters, duplicate snapshots and Windows project identity. The ten-source test now also checks individual-agent grouped details, paginated events, tool isolation and filtered exports through the GUI's local query entry point.
- The integration fixture verifies source-specific golden token totals, individual agent/minute filters, duplicate JSONL records, repeat scans, concatenated zstd frames and SQLite WAL updates.
- Native service tests verify local authentication, single writer, real stop, cached reads after stop, and occupied-port preservation. Actual GUI start/stop/restart and port changes passed; tray behavior and an actual login cycle remain pending.
- Real local source scan found data for Codex, Claude Code, ZCode, WorkBuddy, Grok, OpenCode and Antigravity; ccmr/dsh/Pi were absent in configured roots. This is discovery evidence, not complete numeric parity validation.
- Latest packaged implementation is `a5f8943`: EXE 7,082,496 bytes; ZIP 4,313,086 bytes; six distribution files, no bundled Node. Current source/assets fingerprint, build stamp, distributed file hashes and ZIP bytes independently match. Earlier smaller intermediate executables were not evidence of a complete rendered GUI.
- Initial screenshot access timed out; subsequent native inspection succeeded and exposed a missing production custom-protocol feature. Corrected builds now visibly render populated light/dark views. GUI stop and cached reads work; user-level autostart registration was tested and restored to disabled. DPI and remaining controls still need acceptance; see DESKTOP-VERIFICATION.md.
- Query summary, replay range summary and exports share the event cache. Full replay retains conversation context and is explicitly labelled separately. Unknown replay/hierarchy prices remain unknown, not zero.
- Read-only GUI queries, source revision invalidation, partial UTF-8 tail handling, window single-instance signalling, blocked external navigation and local WebView data directory are implemented. Twenty process-tree TCP samples over approximately 50 seconds found no external TCP connections; UDP and packet capture were not tested.
- Real read-only checks for all Agents and each individual Agent across 5h/7d passed 22 independent Decimal-pricing/cache comparisons. Three absent sources (ccmr/dsh/Pi) have fixture evidence only.
- Native model classification expansion shows unknown values as dashes and known historical weighted input/cache/output prices. Light settings and inline invalid-JSON/negative-rate errors passed; rejected edits left the saved price file unchanged, and the original editor contents were restored and saved.

No final release or full reference-feature parity is claimed by these intermediate checks.
