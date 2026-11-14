# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

This fork starts an independent version line at **0.1.0** as `@ten9miq/upnote-mcp-win`. The 0.2.x entries below describe inherited bellx2/upnote-mcp history, not published releases of this fork.

### Added

- Real Windows retention verification through the reconnected chat MCP: 12 edits of one dedicated note, ten archives retained, two oldest files automatically removed, exact pre-edit row/integrity checks and fresh editor/sync acknowledgements; record the untested byte-ceiling/other-device scope
- Configurable per-note generation and managed-byte backup retention (defaults: 10 / 512 MiB), latest/archive preparation protection, cross-process locking, safe automatic pruning and `backupRetention` reports
- `get_note_edit_context` and `patch_note_in_app`: compact reads plus literal text replacement, section replacement/append and heading rename, preserving untouched HTML source
- Same-snapshot batch planning, overlap/ambiguity/protected-object guards and exact saved-HTML verification using the existing backup/conflict/native sync path
- Long-note protocol and real-app tests: 154407-character note edited with a 389-byte request, formatting/backup/stale-version checks and a fresh app sync acknowledgement
- Opt-in automatic app preparation on MCP startup, `ensure_upnote_connection`, bounded connection/readiness recovery, and shared startup work
- Cross-process launcher mutex and deferred MCP database opening, keeping tools available after startup/temporary DB failures
- Saved-registration live check for cold-app startup, concurrent MCP clients and reconnection without note mutations
- Per-user everyday/startup launcher templates: dynamically resolve the Store app, hide the launcher console, reuse an existing CDP-enabled app, and support background startup
- Opt-in, MCP-only `update_note_in_app` via local CDP and UpNote's internal store action, with backup/version/profile/lock guards and editor/sync acknowledgement checks
- `get_upnote_bridge_status`, safe start launcher, loopback transport tests and isolated/authenticated MCP integration probes
- Verified MCP-only editing on signed-in UpNote 9.22.9: same ID, editor/list refresh, pre-edit backup integrity and fresh app sync acknowledgement in 3.626 seconds
- CDP browser PID ownership verification for Windows environments where the listener is absent from the OS TCP table
- Windows app-editor live workflow: `prepare_app_note_edit` creates a verified backup and stages UTF-8 HTML on the clipboard; a computer-use client pastes into UpNote; `complete_app_note_edit` verifies matching content and a fresh app sync acknowledgement
- Opted-in app-editor real-library verification script and CF_HTML byte-offset tests; confirmed immediate rendering and app-reported sync on UpNote 9.22.9
- In-place `update_note` with title/body replacement or append, keeping the note ID and creation time
- Verified, flushed SQLite snapshots before every edit (including committed WAL data), optimistic row versions and transactional writes
- Dry-run previews and an explicit experimental live-edit option with pending-sync checks and post-commit conflict reporting
- Isolated database tests and MCP integration coverage for editing, backups, rollback and conflicts

### Changed

- Split native VM-runtime and HTTP/WebSocket fixtures into separate test files/processes to prevent the observed Bun 1.4.0 Windows CI crash; preserve all 87 tests without skipping or retrying failures
- Back up only the complete target note row to a checked/flushed `note.sqlite3` recovery archive before every direct, native or partial edit, excluding unrelated notes/tables. Preserve version guards, no-write-on-backup-failure, and existing full-library backups.
- Distinguish fork package/CLI/MCP identity, repository/support links and Windows bundle metadata from upstream; retain MIT attribution
- Reorganize English/Japanese READMEs around CDP behavior, linked implementation comparisons, source setup, automatic launch, security and operational limits
- Include runtime launcher/clipboard helpers in source distribution, exclude tests, and build Windows MCPB artifacts with a matching external PowerShell helper
- Replace inherited automatic npm/macOS release publication with Windows CI and a manual artifact-only preparation workflow; no publication is implied
- Reject final HTML above a conservative 1000000 UTF-8 bytes before backup/write; support inspecting and shrinking an existing oversized note
- Allow 30 seconds for native save requests; keep bounded read-only discovery and separate sync checks
- Run the complete test suite via `bun run test`, with per-file OS isolation for observed Bun 1.4.0/Windows shared-state crashes
- Replace the native bridge's 9.22.9 allowlist with per-call internal API/state, DB column-affinity/unique-ID and note-value checks; allow compatible newer versions and additive schema changes
- Report native compatibility diagnostics and support compatible Promise-returning app actions with write guards rechecked after navigation
- `get_note` returns a version token for edit conflict detection
- Direct SQLite edits normally require UpNote to be quit; their live results never claim UI refresh or cloud-sync success

## Upstream history (bellx2/upnote-mcp)

## [0.2.7] - 2026-08-19

### Fixed

- Resolve UpNote database paths correctly for Claude Desktop MCPB installs
- Expand `${HOME}` in `UPNOTE_DB` and use `os.homedir()` for the default path
- Replace async `Bun.file().exists()` checks with synchronous filesystem checks
- Improve error messages when SQLite cannot open the database file

## [0.2.6] - 2026-08-19

### Added

- MCP Bundle (`.mcpb`) packaging for Claude Desktop one-click installation
- `build:mcpb` script to compile a standalone macOS binary and pack the bundle
- GitHub Release automation that attaches `.mcpb` assets on tagged releases
- MCP Bundle documentation in `README.md` and `README_ja.md`
- `CHANGELOG.md`

## [0.2.5] - 2026-08-18

### Added

- `find_and_open_note` tool to find matching notes by period, keyword, and tag, then open the most recently updated match in UpNote

## [0.2.4] - 2026-08-18

### Added

- `list_recent_notes`, `list_notes_this_week`, and `list_notes_this_month` tools for time-based note listing
- `find_notes` tool to combine period, keyword, and tag filters in one call
- Deep links in structured tool results where applicable

## [0.2.3] - 2026-08-18

### Changed

- Reorganized README around published package usage
- Replaced personal local paths in setup examples with generic placeholders

## [0.2.2] - 2026-08-18

### Added

- Initial read-only MCP server for local UpNote SQLite data
- `search_notes` and `get_note` tools
- `open_note`, `open_notebook`, and `create_note` tools using UpNote's official URL scheme
- `list_notebooks`, `list_tags`, and `search_by_tag` tools
- npm package publishing as `@bellx2/upnote-mcp`
- Trusted publishing workflow for npm releases
- macOS support with configurable `UPNOTE_DB` path
- Permission guidance for first-run MCP client prompts

### Fixed

- Simplified the published CLI entrypoint

[Unreleased]: https://github.com/ten9miq/upnote-mcp-win/compare/385a32e...HEAD
[0.2.7]: https://github.com/bellx2/upnote-mcp/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/bellx2/upnote-mcp/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/bellx2/upnote-mcp/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/bellx2/upnote-mcp/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/bellx2/upnote-mcp/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/bellx2/upnote-mcp/releases/tag/v0.2.2
