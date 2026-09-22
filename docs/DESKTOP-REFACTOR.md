> 历史记录：本文保留原版本的设计或验收事实；当前单一桌面产品与旧版退役状态见 [迁移记录](RETIRE-LEGACY-123.md) 和 [Windows 说明](WINDOWS.md)。

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
- [x] Every agent independently filtered across grouped details, usage pages, activity pages and exports (all ten fixtures; seven sources present in the real local cache).
- [x] Codex full replay and hierarchy verified with fixtures and real GUI.
- [x] Service lifecycle, port collisions, single instance, stopped-service cached queries.
- [ ] GUI theme/layout/DPI inspection, exports, settings persistence.
- [x] No external requests: source audit plus bounded running-process TCP observation (not a permanent network guarantee).
- [x] Release build, no-Node execution, size report, fixed overwrite packaging.

Old worktree edits (.gitignore and two untracked review/plan documents) are pre-existing and not refactor work.

## Current verification evidence (2026-09-20, implementation ready; desktop acceptance open)

- Branch created; complete planning message posted to Room as 9309, implementation updates via messages only.
- User confirmed user-level service: GUI controls, configurable port, tray residence and login startup, without administrator privileges.
- Frontend production build and 32 frontend tests pass. Native tests: 37 unit tests plus four integration tests pass, including all 10 adapters, duplicate snapshots, Windows project identity and activity pagination. The ten-source test checks individual-agent grouped details, paginated events, tool isolation and filtered exports through the GUI's local query entry point.
- The integration fixture verifies source-specific golden token totals, individual agent/minute filters, duplicate JSONL records, repeat scans, concatenated zstd frames and SQLite WAL updates.
- Native service tests verify local authentication, single writer, real stop, cached reads after stop, and occupied-port preservation. Actual GUI start/stop/restart and port changes passed. Close-to-background and single-instance restoration passed; direct tray menu interactions await user-assisted verification because the current UI tool exposes no notification-area window. Current-user startup registration and the background entry point passed; an actual logout/login cycle was not performed.
- Real local source scan found data for Codex, Claude Code, ZCode, WorkBuddy, Grok, OpenCode and Antigravity; ccmr/dsh/Pi were absent in configured roots. This is discovery evidence, not complete numeric parity validation.
- Latest packaged implementation is `0d6f4c2`: EXE 7,105,536 bytes; ZIP 4,324,623 bytes; six distribution files, no bundled Node. Stable-input build completed; distributed manifest hashes and ZIP bytes independently match. Earlier smaller intermediate executables were not evidence of a complete rendered GUI.
- Native light/dark views, long labels, 951×651 navigation, application zoom, settings and exports passed. OS-level DPI/text scaling remains unverified; application zoom is not presented as OS DPI coverage. Earlier custom-protocol and loading-state defects were fixed and reverified; see DESKTOP-VERIFICATION.md.
- Query summary, replay range summary and exports share the event cache. Full replay retains conversation context and is explicitly labelled separately. Unknown replay/hierarchy prices remain unknown, not zero.
- Read-only GUI queries, source revision invalidation, partial UTF-8 tail handling, window single-instance signalling, blocked external navigation and local WebView data directory are implemented. Twenty process-tree TCP samples over approximately 50 seconds found no external TCP connections; UDP and packet capture were not tested.
- Real read-only checks for all Agents and each individual Agent across 5h/7d passed 22 independent Decimal-pricing/cache comparisons. Three absent sources (ccmr/dsh/Pi) have fixture evidence only.
- Native model classification expansion shows unknown values as dashes and known historical weighted input/cache/output prices. Light settings and inline invalid-JSON/negative-rate errors passed; rejected edits left the saved price file unchanged. Alias search and exact-minute historical-price changes passed, with temporary entries removed and original bytes restored.
- Real Codex parent/child replay, failures, patches, raw logs and six replay/cache samples passed. Day/month drilldown preserves the selected minute boundaries. Three real native exports match the selected session's rows, tokens and prices.
- A measured 30-day query with about 54,000 events and 646 sessions exposed a large activity payload. Separate activity pagination plus buffered loopback response writes reduced observed RPC time from 19.8s to 1.6s and JSON from 17.9MB to 1.1MB (two records were added between measurements). Full activity aggregates remain; first/last-page navigation and filter reset passed natively.

No final completion claim is made while desktop acceptance remains open. Online reference features are deliberately excluded by the user's pure-local requirement, not treated as unimplemented local features.
