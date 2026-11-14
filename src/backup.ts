import { closeSync, fsyncSync, mkdtempSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { noteVersion } from "./editing";
import { backupRetentionPolicy, validateBackupRetention, withBackupLock, scanManagedArchives, pruneManagedArchives, type BackupRetentionPolicy, type BackupRetentionReport } from "./backup-retention";

export type BackupOptions = { policy?: BackupRetentionPolicy; protectForMs?: number; onRetention?: (report: BackupRetentionReport) => void };

/** Archive the complete row already read under the source DB's writer reservation. */
export function backupNote(row: Record<string, unknown>, backupsDir: string, sourceDatabase: string, options: BackupOptions = {}): string {
  const policy = options.policy ?? backupRetentionPolicy();
  validateBackupRetention(policy);
  if (options.protectForMs !== undefined && (!Number.isSafeInteger(options.protectForMs) || options.protectForMs < 0)) throw new Error("Invalid backup protection interval.");
  if (typeof row.id !== "string" || !row.id) throw new Error("A note ID is required for a note backup.");
  const entries = Object.entries(row);
  for (const [, value] of entries) {
    if (value !== null && typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value)) && !(value instanceof Uint8Array)) {
      throw new Error("Unsupported SQLite value in note backup; edit refused.");
    }
  }
  return withBackupLock(resolve(backupsDir), root => {
    const previous = scanManagedArchives(root);
    const sequence = previous.archives.reduce((max, archive) => Math.max(max, archive.sequence), 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error("Backup retention sequence exhausted.");
    const version = noteVersion(row);
    const createdAt = new Date().toISOString();
    const directory = mkdtempSync(join(root, `edit-${createdAt.replace(/[:.]/g, "-")}-`));
    const backupPath = join(directory, "note.sqlite3");
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const columns = entries.map(([name]) => quote(name)).join(", ");
    const backup = new Database(backupPath, { create: true, readwrite: true, strict: true });
    try {
      backup.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
      // No declared affinity: avoid coercing strings such as "00123" into numbers.
      // Do not copy source constraints, indexes or triggers into a recovery archive.
      backup.exec(`CREATE TABLE notes (${columns})`);
      backup.query(`INSERT INTO notes (${columns}) VALUES (${entries.map(() => "?").join(", ")})`)
        .run(...entries.map(([, value]) => value as SQLQueryBindings));
      backup.exec("CREATE TABLE mcp_backup_metadata (format_version INTEGER, kind TEXT, note_id TEXT, note_version TEXT, created_at TEXT, source_database TEXT, retention_sequence INTEGER, retain_until INTEGER)");
      backup.query("INSERT INTO mcp_backup_metadata VALUES (1, 'upnote-note', ?, ?, ?, ?, ?, ?)")
        .run(row.id as string, version, createdAt, resolve(sourceDatabase), sequence, Date.now() + (options.protectForMs ?? 0));
      backup.exec("COMMIT");
    } finally {
      if (backup.inTransaction) backup.exec("ROLLBACK");
      backup.close();
    }
    const check = new Database(backupPath, { readonly: true, create: false, strict: true });
    try {
      const integrity = check.query<Record<string, string>, []>("PRAGMA quick_check").all();
      const rows = check.query<Record<string, unknown>, []>("SELECT * FROM notes").all();
      if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== "ok" || rows.length !== 1 || noteVersion(rows[0]!) !== version) {
        throw new Error(`Note backup verification failed: ${backupPath}`);
      }
    } finally { check.close(); }
    const fd = openSync(backupPath, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const retention = pruneManagedArchives(root, backupPath, policy);
    options.onRetention?.(retention);
    for (const warning of retention.warnings) console.error(`UpNote backup retention: ${warning}`);
    return backupPath;
  });
}
