# Per-note backups

Every real edit now archives only the target note's complete SQLite row. This applies to `update_note`, `update_note_in_app`, `patch_note_in_app`, and preparation through `prepare_app_note_edit`. A partial-edit batch creates one archive for the whole batch. Dry runs and no-op edits do not create backups.

## Location and contents

The default location is `MCP Backups/edit-<UTC-time>-<unique-suffix>/note.sqlite3` beside the source database. `UPNOTE_BACKUPS_DIR` overrides the root. Each edit keeps a separate archive; there is no automatic retention cleanup. The change does not automatically delete or convert older full-library backups.

Each archive is a small, independent SQLite database with two tables:

- `notes`: exactly one pre-edit row, including every stored column, HTML, plain text, identity, flags and references. Additional columns, nulls and binary values are retained. Strings such as `00123` are not coerced into numbers.
- `mcp_backup_metadata`: `format_version` (1), `kind` (`upnote-note`), `note_id`, `note_version`, `created_at` (UTC), and `source_database`.

Other notes, source indexes/triggers/constraints, notebook/tag definitions or membership lists in other tables, external image/attachment files, and remote cloud state are excluded. Existing references in the note row are retained, but they are not a copy of those external objects.

## Safety and recovery

Before saving, the server obtains a source writer reservation and rechecks the full-row version. It archives the row read in that transaction, including committed changes visible from WAL, into a separate database transaction. It then reopens the archive, runs `quick_check`, checks that exactly one row matches the expected version, and flushes the archive to disk. A backup or verification failure prevents the edit; the source lock is released. The native workflow rolls back its source reservation without writing UpNote note rows or sync flags, then uses the app's normal save action.

**Do not replace UpNote's `upnote.sqlite3` with `note.sqlite3`.** This is a note-level recovery archive, not a complete UpNote database. Inspect the saved row and current note before applying a reviewed note-level recovery through the app. There is no automatic restore, cloud rollback or automatic retry after an uncertain edit. Backup files contain the target note's private content, so choose their storage location accordingly.

## Verification

The complete suite passed **87 tests in 11 files**, plus TypeScript checks. Tests cover WAL and rollback-journal sources, exact pre-edit rows, exclusion of unrelated notes/tables, bounded archive size despite large unrelated data, binary/additive/quoted columns, independent revisions, stale writes, backup failures, rollback, and native/partial-edit flows.

A read-only export of the dedicated long test note produced a **921600-byte** archive, compared with the **467320832-byte** library database: **99.80% smaller** for that note. The archive contained one exact pre-edit row and passed `integrity_check`. This check did not edit an UpNote note or test cloud synchronization; archive size varies with the target note's contents.
