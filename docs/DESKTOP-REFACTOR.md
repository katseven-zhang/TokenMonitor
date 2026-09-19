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

## Verification gates (pending implementation)

- [ ] Native event collectors for 10 sources; fixed source fixtures and dedup/restart verification.
- [ ] Range boundary, cache token accounting, historical JSON pricing and unknown model checks.
- [ ] Every agent independently filtered across every detail and export.
- [ ] Codex full replay and hierarchy verified with fixtures and real GUI.
- [ ] Service lifecycle, port collisions, single instance, stopped-service cached queries.
- [ ] GUI theme/layout/DPI inspection, exports, settings persistence.
- [ ] No external requests: dependency/source audit plus running-process observation.
- [ ] Release build, no-Node execution, size report, fixed overwrite packaging.

Old worktree edits (.gitignore and two untracked review/plan documents) are pre-existing and not refactor work.

## Current verification evidence (2026-09-20, work in progress)

- Branch created; complete planning message posted to Room as 9309, implementation updates via messages only.
- User confirmed user-level service: GUI controls, configurable port, tray residence and login startup, without administrator privileges.
- Frontend production build and 10 frontend tests pass. Native tests: 35 unit tests plus one integration test covering all 10 adapters pass.
- The integration fixture verifies source-specific golden token totals, individual agent/minute filters, duplicate JSONL records, repeat scans, concatenated zstd frames and SQLite WAL updates.
- Native service tests verify local authentication, single writer, real stop, cached reads after stop, and occupied-port preservation. GUI settings provide restart; live verification of all controls remains pending.
- Real local source scan found data for Codex, Claude Code, ZCode, WorkBuddy, Grok, OpenCode and Antigravity; ccmr/dsh/Pi were absent in configured roots. This is discovery evidence, not complete numeric parity validation.
- A first release executable was 5,742,592 bytes; a later intermediate build was 5,806,592 bytes. No bundled Node. Final packaged size is still pending.
- Initial screenshot access timed out; subsequent native inspection succeeded and exposed a missing production custom-protocol feature. Corrected builds now visibly render populated light/dark views. GUI stop and cached reads work; user-level autostart registration was tested and restored to disabled. DPI and remaining controls still need acceptance; see DESKTOP-VERIFICATION.md.
- Query summary, replay range summary and exports share the event cache. Full replay retains conversation context and is explicitly labelled separately. Unknown replay/hierarchy prices remain unknown, not zero.
- Read-only GUI queries, source revision invalidation, partial UTF-8 tail handling, window single-instance signalling, blocked external navigation and local WebView data directory are implemented. Real runtime/network verification remains pending.

No final release or full reference-feature parity is claimed by these intermediate checks.
