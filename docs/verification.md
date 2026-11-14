# Verification scope

These are measured results from the development environment, not a promise for every installation. No private note content, local backup database, authentication data or machine-specific evidence files are distributed with the project.

## Real Windows app checks (2026-11-14)

Environment: UpNote 9.22.9, Windows Store installation, Bun 1.4.0, signed-in profile. Mutations used dedicated test notes. Other ordinary notes were not edited by these checks.

| Check | Observed result |
| --- | --- |
| Native MCP full-content edit | Same note ID/creation time; editor/list preview refreshed; full backup matched the original row and passed SQLite integrity checks. Fresh app sync acknowledgement in 3.626 seconds. |
| Capability-based compatibility gate | Same installed app passed backup/identity/editor checks; new app sync acknowledgement in 4.420 seconds. Future version labels passed simulated contracts, not actual future builds. |
| Partial editing of a long note | Visible text 154407 characters; original HTML 177050 characters / 465514 UTF-8 bytes. A 389-byte request performed text and section replacement together; compact result 3883 bytes. |
| Unchanged formatting/source | Untouched ranges matched original HTML; highlight class, bold text and table were present in the editor DOM. This is not a claim that arbitrary custom CSS is supported visually by UpNote. |
| Partial-edit safety / sync | ID/creation time preserved, backup exact and integrity OK, stale version rejected without a second write. `htmlPreserved: true`; fresh app sync acknowledgement in 15.177 seconds. |
| Oversized note | An initial 1088312-byte HTML test note failed to sync. It was shortened by section editing, backed up and synced under the same ID. This motivated the conservative 1000000-byte pre-save ceiling. |
| Startup / reconnection | Saved MCP registration started a closed app; concurrent clients became ready with one main UpNote process. Later MCP reconnection/read succeeded. MCP handshake approximately 0.14–0.20 seconds; app initialization continued asynchronously. No note mutation in this check. |
| Shortcut startup | Installed desktop/Start Menu helper reused the app; the login-startup shortcut was executed and produced CDP/background flags. A Windows sign-out/sign-in itself was not tested. |
| Clipboard fallback | UTF-8 Japanese heading/bold/list text rendered through app paste and the app recorded a new sync acknowledgement. This separate workflow used computer use. |

An unsigned-in disposable-profile native test verified local save/DOM/backup and correctly reported sync as unverified. It is not evidence of authenticated cloud sync.

## Automated tests

The current suite passes all 87 tests in eleven files and TypeScript checks, including per-note archives. The suite covers direct/native editing, archive integrity/exact row equality/rollback, exclusion of unrelated notes/tables, stale versions, metadata races, runtime/schema/value compatibility, async app actions, startup recovery, CF_HTML byte offsets, partial-operation ambiguity/overlap/protected objects and exact saved HTML. See [per-note backup verification](note-backups.md#verification) for the measured size reduction.

Long-note tests include multi-megabyte HTML and 8000 replacements. An isolated stdio MCP test reads a 6 MiB synthetic note compactly, rejects its oversized save, and checks a compact preview of an approximately 800 kB note against a fake app endpoint. This does not demonstrate real cloud syncing above UpNote's size limit.

Run `bun run check` and `bun run test`. Per-file OS isolation avoids observed Bun 1.4.0/Windows shared-process crashes; VM runtime and HTTP/WebSocket fixtures are separate files/processes after a single-file combination crashed on Windows CI. A runtime crash is a failed run, not an application assertion pass. Do not hide failures with automatic retries.

## Reproducing live checks

- `scripts/inspect-native-bridge.ts`: read-only capability inspection of a configured endpoint.
- `scripts/verify-upnote-cdp-owner.ts`: verifies the CDP browser PID, including Windows environments where the listener is absent from the OS TCP table.
- `scripts/live-native-edit-check.ts TEST_NOTE_ID OUTPUT_JSON --edit-test-note`: only dedicated `MCP実機テスト ` notes; backs up and edits through the real MCP tool.
- `scripts/live-partial-edit-check.ts OUTPUT_JSON --create-long-test-note`: explicitly creates and edits a dedicated test note; preserves the note and backups. `--existing-test-note ID` resumes a matching test note.
- `scripts/verify-codex-connection.ts OUTPUT_JSON`: read-only saved-registration connection probe. Its test harness expects the development registration key `upnote-local` and automatic startup; adapt it for another registration.
- `scripts/test-native-bridge.ts`: unsigned-in disposable `.cache/upnote-cdp-probe` profile only.

These probes are not automatic tests. Review them before using a logged-in library; do not run mutation probes on ordinary notes. Evidence outputs and snapshots must remain outside published archives.

## Publication preparation checks (2026-11-15)

- Independent package/CLI/MCP identity and version matched: `@ten9miq/upnote-mcp-win` / 0.1.0. Frozen-lockfile installation, TypeScript checks and all 87 tests passed, including assertions on the MCP server's name/version and per-note archives.
- Bun pack and npm dry-run agreed on 24 distribution files, including the per-note backup module and documentation. No test sources, live mutation probes, local DBs/backups, caches or credentials were included. The generated tarball was installed into a disposable consumer project.
- The installed tarball and compiled Windows executable both completed an actual stdio MCP handshake and advertised all 21 manifest tools. They correctly reported a deliberately missing temporary DB without losing tool availability; no real library or CDP connection was used.
- MCPB packer 2.1.2 validated the Windows manifest and built the x64 archive. Its four files were the manifest, executable, external PowerShell clipboard helper and MIT license. Claude Desktop installation and interactive clipboard execution were not part of this package smoke check.
- English/Japanese README and linked docs were checked for relative links and JSON/TOML configuration syntax. Windows CI/artifact workflows were parsed locally but not run on GitHub-hosted runners.

## Remaining gaps

Other-device receipt, future real UpNote versions, non-Store automatic startup, macOS/Linux CDP behavior and end-to-end installation of the new Windows MCPB in Claude Desktop have not been verified. Compilation/package smoke checks do not fill these gaps. Updates to undocumented APIs may still require code changes even when names/types appear compatible.
