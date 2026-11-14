import { lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, unlinkSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { noteVersion } from "./editing";

export type BackupRetentionPolicy = { maxGenerations: number; maxTotalBytes: number };
export type BackupRetentionReport = BackupRetentionPolicy & {
  archiveCount: number; totalBytes: number; deletedArchives: number; deletedBytes: number;
  protectedArchives: number; limitsExceeded: boolean; warnings: string[];
};
export const DEFAULT_BACKUP_RETENTION: BackupRetentionPolicy = { maxGenerations: 10, maxTotalBytes: 512 * 1024 * 1024 };
const directoryPattern = /^edit-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-zA-Z0-9]+$/;

export function backupRetentionPolicy(env: Record<string, string | undefined> = process.env): BackupRetentionPolicy {
  const read = (name: string, fallback: number) => {
    const value = env[name];
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} must be a positive safe integer.`);
    return Number(value);
  };
  return { maxGenerations: read("UPNOTE_BACKUP_MAX_GENERATIONS", DEFAULT_BACKUP_RETENTION.maxGenerations),
    maxTotalBytes: read("UPNOTE_BACKUP_MAX_TOTAL_BYTES", DEFAULT_BACKUP_RETENTION.maxTotalBytes) };
}

export function validateBackupRetention(policy: BackupRetentionPolicy): void {
  for (const value of [policy.maxGenerations, policy.maxTotalBytes]) if (!Number.isSafeInteger(value) || value < 1) throw new Error("Backup retention limits must be positive safe integers.");
}

/** A SQLite reservation serializes creation + pruning across MCP processes; crashes release it. */
export function withBackupLock<T>(directory: string, work: (root: string) => T): T {
  mkdirSync(directory, { recursive: true });
  const root = realpathSync(directory);
  const path = join(root, ".retention-lock.sqlite3");
  try { if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error("Backup retention lock must be a regular file."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const db = new Database(path, { create: true, readwrite: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS retention_lock(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE");
    return work(root);
  } finally { if (db.inTransaction) db.exec("ROLLBACK"); db.close(); }
}

export type ManagedArchive = {
  path: string; directory: string; group: string; sequence: number; time: number; retainUntil: number;
  bytes: number; identity: string; payload?: { path: string; identity: string; bytes: number };
};
function regularFile(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Not a regular backup file.");
  return { identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`, bytes: stat.size };
}
function inside(root: string, path: string) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Backup path escapes its configured root.");
}

/** Only positively identified, complete note archives are eligible for automatic deletion. */
function readArchive(root: string, directory: string): ManagedArchive {
  inside(root, directory);
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new Error("Backup directory is a link or has changed.");
  const path = join(directory, "note.sqlite3");
  const file = regularFile(path);
  const db = new Database(path, { readonly: true, create: false, strict: true });
  let meta: Record<string, unknown>; let row: Record<string, unknown>;
  try {
    const metadata = db.query<Record<string, unknown>, []>("SELECT * FROM mcp_backup_metadata LIMIT 2").all();
    const rows = db.query<Record<string, unknown>, []>("SELECT * FROM notes LIMIT 2").all();
    if (metadata.length !== 1 || rows.length !== 1) throw new Error("Not a complete single-note archive.");
    meta = metadata[0]!; row = rows[0]!;
    if (meta.format_version !== 1 || meta.kind !== "upnote-note" || typeof meta.note_id !== "string" || !meta.note_id || row.id !== meta.note_id || meta.note_version !== noteVersion(row) || typeof meta.source_database !== "string" || !isAbsolute(meta.source_database)) throw new Error("Backup identity/version does not match.");
  } finally { db.close(); }
  const time = typeof meta.created_at === "string" ? Date.parse(meta.created_at) : NaN;
  if (!Number.isFinite(time) || !basename(directory).startsWith(`edit-${new Date(time).toISOString().replace(/[:.]/g, "-")}-`)) throw new Error("Backup timestamp/directory does not match.");
  const sequence = meta.retention_sequence ?? 0, retainUntil = meta.retain_until ?? 0;
  if (!Number.isSafeInteger(sequence) || Number(sequence) < 0 || !Number.isSafeInteger(retainUntil) || Number(retainUntil) < 0) throw new Error("Invalid retention metadata.");
  const source = resolve(meta.source_database as string);
  const result: ManagedArchive = { path, directory, group: JSON.stringify([process.platform === "win32" ? source.toLowerCase() : source, meta.note_id]), sequence: Number(sequence), time, retainUntil: Number(retainUntil), ...file };
  const payloadPath = join(directory, "app-edit-clipboard.json");
  try {
    const payload = regularFile(payloadPath);
    if (payload.bytes > 16 * 1024 * 1024) throw new Error("Clipboard payload is too large to identify.");
    const data = JSON.parse(readFileSync(payloadPath, "utf8"));
    if (data.kind !== "upnote-app-edit-v1" || data.id !== meta.note_id) throw new Error("Clipboard payload does not match the archive.");
    result.payload = { path: payloadPath, ...payload }; result.bytes += payload.bytes;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return result;
}

export function scanManagedArchives(root: string): { archives: ManagedArchive[]; warnings: string[] } {
  const archives: ManagedArchive[] = [], warnings: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!directoryPattern.test(entry.name)) continue;
    const directory = join(root, entry.name);
    try {
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Linked/non-directory archive ignored.");
      // Older full-library backups and unrelated directories are deliberately unmanaged.
      try { lstatSync(join(directory, "note.sqlite3")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      archives.push(readArchive(root, directory));
    } catch (error) { warnings.push(`Kept unrecognized/unreadable archive ${entry.name}: ${String(error)}`); }
  }
  return { archives, warnings };
}

const newestFirst = (a: ManagedArchive, b: ManagedArchive) => b.sequence - a.sequence || b.time - a.time || b.path.localeCompare(a.path);
export function pruneManagedArchives(root: string, protectedPath: string, policy: BackupRetentionPolicy): BackupRetentionReport {
  const { archives, warnings } = scanManagedArchives(root);
  if (!archives.some(archive => archive.path === protectedPath)) throw new Error("The new backup cannot be verified for retention; no cleanup performed.");
  archives.sort(newestFirst);
  const groups = new Map<string, ManagedArchive[]>();
  for (const archive of archives) { const group = groups.get(archive.group) ?? []; group.push(archive); groups.set(archive.group, group); }
  const protect = new Set([...groups.values()].map(group => group[0]!.path));
  protect.add(protectedPath);
  for (const archive of archives) if (archive.retainUntil > Date.now()) protect.add(archive.path);
  const remove = new Set<string>();
  for (const group of groups.values()) for (const archive of group.slice(policy.maxGenerations)) if (!protect.has(archive.path)) remove.add(archive.path);
  let plannedBytes = archives.reduce((sum, a) => sum + a.bytes, 0) - archives.filter(a => remove.has(a.path)).reduce((sum, a) => sum + a.bytes, 0);
  for (const archive of [...archives].reverse()) if (plannedBytes > policy.maxTotalBytes && !protect.has(archive.path) && !remove.has(archive.path)) { remove.add(archive.path); plannedBytes -= archive.bytes; }
  let deletedArchives = 0, deletedBytes = 0;
  const initialBytes = archives.reduce((sum, archive) => sum + archive.bytes, 0);
  const remaining = [...archives];
  for (const archive of [...archives].reverse()) {
    if (!remove.has(archive.path)) continue;
    try {
      // Recheck ownership, containment and file identity immediately before unlinking.
      const current = readArchive(root, archive.directory);
      if (current.identity !== archive.identity || current.group !== archive.group || current.payload?.identity !== archive.payload?.identity) throw new Error("Archive changed during cleanup.");
      inside(root, archive.path);
      if (archive.payload) { unlinkSync(archive.payload.path); deletedBytes += archive.payload.bytes; }
      unlinkSync(archive.path);
      deletedArchives++; deletedBytes += archive.bytes - (archive.payload?.bytes ?? 0);
      remaining.splice(remaining.indexOf(archive), 1);
      // Never recursively remove a directory: any unrelated files remain untouched.
      try { rmdirSync(archive.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error; }
    } catch (error) { warnings.push(`Could not fully remove old archive ${archive.directory}: ${String(error)}`); }
  }
  const totalBytes = initialBytes - deletedBytes;
  const overGenerations = [...groups.values()].some(group => group.filter(a => remaining.includes(a)).length > policy.maxGenerations);
  const limitsExceeded = totalBytes > policy.maxTotalBytes || overGenerations;
  if (limitsExceeded) warnings.push("Backup limits remain exceeded: newest backups and active clipboard preparations are preserved; deletion failures may also require attention.");
  return { ...policy, archiveCount: remaining.length, totalBytes, deletedArchives, deletedBytes, protectedArchives: protect.size, limitsExceeded, warnings };
}

/** Recount a clipboard preparation after its payload has been written/staged. */
export function refreshBackupRetention(path: string): BackupRetentionReport {
  const policy = backupRetentionPolicy();
  return withBackupLock(dirname(dirname(path)), root => {
    const report = pruneManagedArchives(root, path, policy);
    for (const warning of report.warnings) console.error(`UpNote backup retention: ${warning}`);
    return report;
  });
}
