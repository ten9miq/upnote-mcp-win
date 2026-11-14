import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { backupNote, type BackupOptions } from "./backup";
import { backupRetentionPolicy, scanManagedArchives, withBackupLock, type BackupRetentionReport } from "./backup-retention";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(directory));
    if (rel.startsWith("..") || isAbsolute(rel) || !basename(directory).startsWith("upnote-retention-")) throw new Error("Unsafe fixture cleanup target.");
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "upnote-retention-")); directories.push(directory);
  return { directory, root: join(directory, "backups"), source: join(directory, "source.sqlite3") };
}
const keep = { maxGenerations: 100, maxTotalBytes: 100_000_000 };
function archive(f: ReturnType<typeof fixture>, id: string, text: string, options: BackupOptions = {}) {
  let report!: BackupRetentionReport;
  const path = backupNote({ id, title: id, html: `<h2>${id}</h2><p>${text}</p>`, text }, f.root, f.source,
    { policy: keep, ...options, onRetention: value => { report = value; } });
  return { path, report };
}
function alter(path: string, sql: string) { const db = new Database(path); try { db.exec(sql); } finally { db.close(); } }

test("per-note generations prune older revisions and preserve each note's newest archive", () => {
  const f = fixture();
  const a1 = archive(f, "a", "v1"), b1 = archive(f, "b", "v1"), a2 = archive(f, "a", "v2");
  const a3 = archive(f, "a", "v3", { policy: { ...keep, maxGenerations: 2 } });
  expect(existsSync(a1.path)).toBe(false); expect(existsSync(b1.path)).toBe(true);
  expect(existsSync(a2.path)).toBe(true); expect(existsSync(a3.path)).toBe(true);
  expect(a3.report).toMatchObject({ archiveCount: 3, deletedArchives: 1, protectedArchives: 2, limitsExceeded: false });
});

test("total byte limit removes oldest removable archives globally across notes", () => {
  const f = fixture();
  const a1 = archive(f, "a", "old"), b1 = archive(f, "b", "old"), a2 = archive(f, "a", "new");
  const each = statSync(a2.path).size;
  const b2 = archive(f, "b", "new", { policy: { ...keep, maxTotalBytes: each * 3 } });
  expect(existsSync(a1.path)).toBe(false); expect(existsSync(b1.path)).toBe(true);
  expect(existsSync(a2.path)).toBe(true); expect(existsSync(b2.path)).toBe(true);
  expect(b2.report.totalBytes).toBe(each * 3); expect(b2.report.limitsExceeded).toBe(false);
});

test("latest-per-note protection takes priority when the byte ceiling is impossible", () => {
  const f = fixture(); const a = archive(f, "a", "one");
  const b = archive(f, "b", "two", { policy: { maxGenerations: 1, maxTotalBytes: 1 } });
  expect(existsSync(a.path)).toBe(true); expect(existsSync(b.path)).toBe(true);
  expect(b.report).toMatchObject({ limitsExceeded: true, deletedArchives: 0, protectedArchives: 2 });
  expect(b.report.warnings.join(" ")).toContain("newest backups");
});

test("identical note IDs from different source profiles have independent newest backups", () => {
  const f = fixture(); const a = archive(f, "same-id", "profile-a");
  const b = archive({ ...f, source: join(f.directory, "second.sqlite3") }, "same-id", "profile-b", { policy: { maxGenerations: 1, maxTotalBytes: 1 } });
  expect(existsSync(a.path)).toBe(true); expect(existsSync(b.path)).toBe(true); expect(b.report.protectedArchives).toBe(2);
});

test("existing format-1 archives without retention columns migrate without losing the newest", () => {
  const f = fixture(); const a1 = archive(f, "a", "old"), b = archive(f, "b", "keep");
  for (const item of [a1, b]) alter(item.path, "ALTER TABLE mcp_backup_metadata DROP COLUMN retention_sequence; ALTER TABLE mcp_backup_metadata DROP COLUMN retain_until");
  const a2 = archive(f, "a", "new", { policy: { ...keep, maxGenerations: 1 } });
  expect(existsSync(a1.path)).toBe(false); expect(existsSync(b.path)).toBe(true); expect(a2.report.archiveCount).toBe(2);
});

test("invalid retention configuration fails before creating a backup directory", () => {
  expect(backupRetentionPolicy({})).toEqual({ maxGenerations: 10, maxTotalBytes: 536870912 });
  expect(backupRetentionPolicy({ UPNOTE_BACKUP_MAX_GENERATIONS: "3", UPNOTE_BACKUP_MAX_TOTAL_BYTES: "1048576" })).toEqual({ maxGenerations: 3, maxTotalBytes: 1048576 });
  for (const value of ["", "0", "-1", "1.2", "2e3", "Infinity", "9007199254740992"]) {
    expect(() => backupRetentionPolicy({ UPNOTE_BACKUP_MAX_GENERATIONS: value })).toThrow();
    expect(() => backupRetentionPolicy({ UPNOTE_BACKUP_MAX_TOTAL_BYTES: value })).toThrow();
  }
  const f = fixture(); expect(() => archive(f, "a", "x", { policy: { ...keep, maxGenerations: 0 } })).toThrow();
  expect(existsSync(f.root)).toBe(false);
});

test("failed new backup never starts pruning existing revisions", () => {
  const f = fixture(); const a1 = archive(f, "a", "one"), a2 = archive(f, "a", "two");
  expect(() => backupNote({ id: "a", invalid: {} }, f.root, f.source, { policy: { maxGenerations: 1, maxTotalBytes: 1 } })).toThrow();
  expect(existsSync(a1.path)).toBe(true); expect(existsSync(a2.path)).toBe(true);
});

test("legacy whole-library, corrupt and unexpected files are not auto-deleted", () => {
  const f = fixture(); const broken = archive(f, "broken", "old");
  alter(broken.path, "UPDATE notes SET text='tampered'");
  const legacy = join(f.root, "edit-2020-01-01T00-00-00-000Z-legacy"); mkdirSync(legacy);
  writeFileSync(join(legacy, "upnote.sqlite3"), "legacy library");
  const odd = join(f.root, "unrelated"); mkdirSync(odd); writeFileSync(join(odd, "note.sqlite3"), "unrelated");
  const current = archive(f, "a", "new", { policy: { maxGenerations: 1, maxTotalBytes: 1 } });
  expect(existsSync(broken.path)).toBe(true); expect(readFileSync(join(legacy, "upnote.sqlite3"), "utf8")).toBe("legacy library");
  expect(readFileSync(join(odd, "note.sqlite3"), "utf8")).toBe("unrelated");
  expect(current.report.warnings.some(value => value.includes("identity/version"))).toBe(true);
});

test("deletion only unlinks owned files and leaves unrelated directory contents", () => {
  const f = fixture(); const old = archive(f, "a", "old"); const extra = join(dirname(old.path), "keep.txt"); writeFileSync(extra, "keep");
  archive(f, "a", "new", { policy: { ...keep, maxGenerations: 1 } });
  expect(existsSync(old.path)).toBe(false); expect(readFileSync(extra, "utf8")).toBe("keep");
});

test("owned clipboard payloads count toward capacity and expire with their archive", () => {
  const f = fixture(); const old = archive(f, "a", "old");
  const payload = join(dirname(old.path), "app-edit-clipboard.json");
  writeFileSync(payload, JSON.stringify({ kind: "upnote-app-edit-v1", id: "a", html: "x".repeat(20_000) }));
  const oldBytes = statSync(old.path).size + statSync(payload).size;
  const latest = archive(f, "a", "new", { policy: { ...keep, maxTotalBytes: statSync(old.path).size } });
  expect(latest.report.deletedBytes).toBe(oldBytes); expect(existsSync(payload)).toBe(false); expect(existsSync(old.path)).toBe(false);
});

test("active clipboard backup pin survives tight limits and becomes deletable after expiry", () => {
  const f = fixture(); const pinned = archive(f, "a", "pending", { protectForMs: 11 * 60_000 });
  const current = archive(f, "a", "new", { policy: { maxGenerations: 1, maxTotalBytes: 1 } });
  expect(existsSync(pinned.path)).toBe(true); expect(current.report.limitsExceeded).toBe(true);
  alter(pinned.path, "UPDATE mcp_backup_metadata SET retain_until=1");
  const after = archive(f, "a", "newer", { policy: { ...keep, maxGenerations: 1 } });
  expect(existsSync(pinned.path)).toBe(false); expect(existsSync(current.path)).toBe(false); expect(after.report.archiveCount).toBe(1);
});

test("directory symlinks and junctions cannot direct cleanup outside the configured root", () => {
  const f = fixture(); mkdirSync(f.root); const outside = join(f.directory, "outside"); mkdirSync(outside);
  const foreign = join(outside, "note.sqlite3"); writeFileSync(foreign, "do not touch");
  const link = join(f.root, "edit-2020-01-01T00-00-00-000Z-linked"); symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const result = archive(f, "a", "new", { policy: { maxGenerations: 1, maxTotalBytes: 1 } });
  expect(readFileSync(foreign, "utf8")).toBe("do not touch"); expect(existsSync(link)).toBe(true); expect(result.report.warnings.some(value => value.includes("Linked"))).toBe(true);
});

test("delete failures retain the backup, protect the latest and report excess capacity", () => {
  const f = fixture(); const before = archive(f, "a", "before");
  const original = fs.unlinkSync;
  const failure = spyOn(fs, "unlinkSync").mockImplementation(path => {
    if (path === before.path) throw Object.assign(new Error("file busy"), { code: "EBUSY" });
    return original(path);
  });
  try {
    const after = archive(f, "a", "after", { policy: { maxGenerations: 1, maxTotalBytes: 1 } });
    expect(existsSync(before.path)).toBe(true); expect(existsSync(after.path)).toBe(true);
    expect(after.report).toMatchObject({ archiveCount: 2, deletedArchives: 0, limitsExceeded: true });
    expect(after.report.warnings.join(" ")).toContain("file busy");
  } finally { failure.mockRestore(); }
});

test("concurrent processes serialize backup creation and enforce the final generation count", async () => {
  const f = fixture();
  const module = JSON.stringify(resolve(import.meta.dir, "backup.ts"));
  const script = `import { backupNote } from ${module}; for(let i=0;i<4;i++) backupNote({id:'shared',text:String(i)},process.argv[1],process.argv[2],{policy:{maxGenerations:2,maxTotalBytes:10000000}});`;
  const children = [0, 1, 2].map(() => Bun.spawn([process.execPath, "-e", script, f.root, f.source], { stdout: "pipe", stderr: "pipe" }));
  for (const child of children) { const error = await new Response(child.stderr).text(); expect(await child.exited, error).toBe(0); }
  const managed = scanManagedArchives(f.root).archives;
  expect(managed).toHaveLength(2); expect(new Set(managed.map(a => a.sequence)).size).toBe(2);
  expect(Math.max(...managed.map(a => a.sequence))).toBe(12);
}, 15_000);

test("a held retention lock prevents another process from creating or pruning backups", () => {
  const f = fixture(); const before = archive(f, "a", "before");
  const child = withBackupLock(f.root, () => {
    const module = JSON.stringify(resolve(import.meta.dir, "backup.ts"));
    const code = `import { backupNote } from ${module}; backupNote({id:'a',text:'blocked'},process.argv[1],process.argv[2]);`;
    return Bun.spawnSync([process.execPath, "-e", code, f.root, f.source], { stdout: "pipe", stderr: "pipe", timeout: 6000 });
  });
  expect(child.exitCode).not.toBe(0); expect(child.stderr.toString()).toMatch(/locked|busy/i); expect(existsSync(before.path)).toBe(true);
  expect(readdirSync(f.root).filter(name => name.startsWith("edit-"))).toHaveLength(1);
}, 10_000);
