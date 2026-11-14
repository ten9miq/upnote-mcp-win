# Per-note backups

Every real edit now archives only the target note's complete SQLite row. This applies to `update_note`, `update_note_in_app`, `patch_note_in_app`, and preparation through `prepare_app_note_edit`. A partial-edit batch creates one archive for the whole batch. Dry runs and no-op edits do not create backups.

## Location and contents

The default location is `MCP Backups/edit-<UTC-time>-<unique-suffix>/note.sqlite3` beside the source database. `UPNOTE_BACKUPS_DIR` overrides the root. Each edit creates a separate archive, then automatically prunes older managed archives under the policy below. Older full-library backups are not automatically deleted or converted.

Each archive is a small, independent SQLite database with two tables:

- `notes`: exactly one pre-edit row, including every stored column, HTML, plain text, identity, flags and references. Additional columns, nulls and binary values are retained. Strings such as `00123` are not coerced into numbers.
- `mcp_backup_metadata`: `format_version` (1), `kind` (`upnote-note`), `note_id`, `note_version`, `created_at` (UTC), `source_database`, and new `retention_sequence` / `retain_until` fields. Existing format-1 archives without the new fields are recognized.

Other notes, source indexes/triggers/constraints, notebook/tag definitions or membership lists in other tables, external image/attachment files, and remote cloud state are excluded. Existing references in the note row are retained, but they are not a copy of those external objects.

## Automatic retention

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `UPNOTE_BACKUP_MAX_GENERATIONS` | `10` | Maximum retained generations per note and source database/profile. |
| `UPNOTE_BACKUP_MAX_TOTAL_BYTES` | `536870912` (512 MiB) | Maximum total bytes of managed archives and their identified clipboard payloads in this backup root. |

Both values must be positive safe integers. Zero/unlimited, fractional or invalid values are rejected before creating a backup or editing the note. Values are read when a real backup is created. No cleanup runs on a dry run, a no-op edit or a timer. A changed policy takes effect on the next successful backup; reconnect MCP after changing its environment.

In a Codex MCP environment section, for example:

```toml
[mcp_servers.upnote-local.env]
UPNOTE_BACKUP_MAX_GENERATIONS = '5'
UPNOTE_BACKUP_MAX_TOTAL_BYTES = '268435456' # 256 MiB
```

Add these keys to the existing environment section; do not replace your database/CDP/startup settings or create a duplicate TOML section. Use your existing MCP server key if it differs from `upnote-local`. The Windows MCPB also exposes these two settings as numeric user-config fields.

Cleanup starts only after the new archive has passed row/version/integrity verification and disk flush. First it removes excess per-note generations, then the oldest remaining removable archives until the byte target is met. A monotonically allocated sequence orders new archives even when timestamps tie or the system clock changes; older format-1 archives use their recorded UTC time. Different source database paths with the same note ID have separate latest-backup protection.

**The latest valid archive of each note/profile is always preserved.** The just-created archive is also protected. Clipboard preparations receive an eleven-minute minimum protection window covering the normal ten-minute ticket workflow; recognized clipboard JSON payloads count toward the byte total and are deleted with expired archives. When protected archives alone exceed the limits, or file deletion fails, cleanup keeps them and returns `backupRetention.limitsExceeded: true` with warnings. The limits are therefore targets subject to protection, not unconditional disk quotas. Lower limits never justify deleting the last valid recovery copy of a note.

Every actual-edit result includes `backupRetention` with the configured limits, current managed `archiveCount` / `totalBytes`, `deletedArchives` / `deletedBytes`, protected count and warnings. Clipboard preparation refreshes this report after writing/staging its payload. Completion returns the preparation's recorded report, not a new live disk scan. Warnings also go to MCP stderr.

The root's small `.retention-lock.sqlite3` serializes creation and pruning across MCP processes; SQLite releases locks if a process crashes. The lock database does not store notes. If the lock cannot be acquired within two seconds, the edit is refused rather than cleaning concurrently. Never remove this lock file while MCP processes are active.

Only identified, version-matching one-note archives in direct `edit-…` child directories are managed. Legacy whole-library backups, malformed/unreadable archives, symlinks/junctions, unrelated files and orphan payloads without an archive are left untouched; these files and the small lock database are **outside the managed-byte total**. Their disk usage can therefore exceed this policy and requires manual review. Cleanup validates paths/ownership before unlinking known files and only removes a directory if empty; it never recursively deletes the backup root or unrelated contents.

## Safety and recovery

Before saving, the server obtains a source writer reservation and rechecks the full-row version. It archives the row read in that transaction, including committed changes visible from WAL, into a separate database transaction. It then reopens the archive, runs `quick_check`, checks that exactly one row matches the expected version, and flushes the archive to disk. A backup or verification failure prevents the edit; the source lock is released. The native workflow rolls back its source reservation without writing UpNote note rows or sync flags, then uses the app's normal save action.

**Do not replace UpNote's `upnote.sqlite3` with `note.sqlite3`.** This is a note-level recovery archive, not a complete UpNote database. Inspect the saved row and current note before applying a reviewed note-level recovery through the app. There is no automatic restore, cloud rollback or automatic retry after an uncertain edit. Backup files contain the target note's private content, so choose their storage location accordingly.

## Verification

The retention implementation passed **102 tests in 12 files**, plus TypeScript checks. Tests cover WAL and rollback-journal sources, exact pre-edit rows, exclusion of unrelated notes/tables, bounded archive size despite large unrelated data, binary/additive/quoted columns, independent revisions, stale writes, backup failures, rollback, and native/partial-edit flows. Retention tests cover generation and byte limits, latest/pending protection, format migration, same-ID profiles, invalid settings, failed backup/deletion, unsafe paths/unrelated contents, multi-process races and lock timeout. The MCP integration test verifies that environment settings and protected-limit warnings appear in actual tool results. All tests use temporary data; production backups are not pruned by the test suite.

A read-only export of the dedicated long test note produced a **921600-byte** archive, compared with the **467320832-byte** library database: **99.80% smaller** for that note. The archive contained one exact pre-edit row and passed `integrity_check`. This check did not edit an UpNote note or test cloud synchronization; archive size varies with the target note's contents.
