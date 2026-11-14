import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { htmlToPlainText, renderBody } from "./editing";
import { UpNoteRepository } from "./upnote";
import { NativeConnectionUnavailable, type NativeChannel } from "./native-bridge";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixture(options: { running?: () => boolean; journal?: "WAL" | "DELETE"; observeLiveMs?: number; stageClipboard?: (path: string) => Promise<void>; connectNative?: () => Promise<NativeChannel>; autoStart?: boolean; startNativeApp?: () => Promise<void> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "upnote-edit-test-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "upnote.sqlite3");
  const backupsDir = join(directory, "backups");
  const db = new Database(path);
  cleanup.push(() => db.close());
  db.exec(`
    PRAGMA journal_mode=${options.journal ?? "WAL"};
    PRAGMA wal_autocheckpoint=0;
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, title TEXT, html TEXT, text TEXT, summary TEXT,
      createdAt DOUBLE, updatedAt DOUBLE, revision INTEGER DEFAULT 4,
      synced INTEGER DEFAULT 1, deleted INTEGER DEFAULT 0, trashed INTEGER DEFAULT 0,
      hasTodo INTEGER DEFAULT 0, filesCount INTEGER DEFAULT 0, fileIds TEXT DEFAULT '[]',
      firstImage TEXT, tagLinks TEXT DEFAULT '["work"]', noteLinks TEXT DEFAULT '[]',
      bookmarked INTEGER DEFAULT 1, pinned INTEGER DEFAULT 1, space TEXT DEFAULT 'space-a'
    );
    CREATE TABLE lists (id TEXT PRIMARY KEY, content TEXT);
    INSERT INTO lists VALUES ('notebooks_nb', '["note-a","note-b"]');
    INSERT INTO notes (id,title,html,text,summary,createdAt,updatedAt) VALUES
      ('note-a','Old title','<h2>Old title</h2><p>Old body</p>','Old title\nOld body','Old body',100,200),
      ('note-b','Other','<h2>Other</h2>','Other','Other',101,201);
  `);
  if (options.connectNative) db.exec("ALTER TABLE notes ADD COLUMN syncedAt DOUBLE DEFAULT 1");
  const repository = new UpNoteRepository(path, {
    backupsDir, isUpNoteRunning: options.running ?? (() => false), observeLiveMs: options.observeLiveMs ?? 0,
    stageClipboard: options.stageClipboard ?? (async () => {}),
    autoStart: options.autoStart ?? false, startNativeApp: options.startNativeApp,
    ...(options.connectNative ? { nativeEndpoint: "http://127.0.0.1:19330", connectNative: options.connectNative } : {}),
  });
  cleanup.push(() => repository.close());
  const row = () => db.query<Record<string, unknown>, []>("SELECT * FROM notes WHERE id='note-a'").get()!;
  const params = () => ({ id: "note-a", expectedVersion: repository.getNote("note-a").version });
  return { directory, path, backupsDir, db, repository, row, params };
}

for (const journal of ["WAL", "DELETE"] as const) {
  test(`edit keeps identity and metadata; ${journal} backup contains exact pre-edit data`, async () => {
    const f = fixture({ journal });
    const before = f.row();
    const beforeVersion = f.params().expectedVersion;
    const result = await f.repository.updateNote({ ...f.params(), title: "New & title", content: "## Heading\n\n**New** body &copy;\n\n- [ ] todo" });
    expect(result.committed).toBe(true);
    expect(result.databaseVerification).toBe("matches");
    expect(result.cloudSync).toBe("unverified");
    expect(result.id).toBe("note-a");
    const after = f.row();
    for (const field of ["id", "createdAt", "fileIds", "firstImage", "tagLinks", "noteLinks", "space", "pinned", "bookmarked"]) expect(after[field]).toEqual(before[field]);
    expect(after.synced).toBe(0);
    expect(after.revision).toBe(5);
    expect(Number(after.updatedAt)).toBeGreaterThan(200);
    expect(after.html).toContain("<h2>New &amp; title</h2>");
    expect(after.text).toContain("New & title");
    expect(after.text).toContain("©");
    expect(after.hasTodo).toBe(1);
    expect(result.note?.version).not.toBe(beforeVersion);
    const backup = new Database(result.backupPath!, { readonly: true, create: false });
    try {
      expect(backup.query("SELECT * FROM notes WHERE id='note-a'").get()).toEqual(before);
      expect(backup.query("SELECT content FROM lists").get()).toEqual({ content: '["note-a","note-b"]' });
      expect(backup.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally { backup.close(); }
  });
}

test("dry run previews the edit while UpNote runs without writing or backing up", async () => {
  const f = fixture({ running: () => true });
  const before = f.row();
  const result = await f.repository.updateNote({ ...f.params(), content: "Preview", dryRun: true });
  expect(result.preview?.html).toContain("Preview");
  expect(result.committed).toBe(false);
  expect(result.backupPath).toBeNull();
  expect(f.row()).toEqual(before);
  expect(existsSync(f.backupsDir)).toBe(false);
});

test("stale versions, including metadata-only changes, cannot overwrite a note", async () => {
  const f = fixture();
  const params = f.params();
  f.db.exec("UPDATE notes SET pinned=0 WHERE id='note-a'");
  await expect(f.repository.updateNote({ ...params, content: "Stale overwrite" })).rejects.toThrow("changed since get_note");
  expect(f.row().html).toContain("Old body");
  expect(existsSync(f.backupsDir)).toBe(false);
});

test("running edits require explicit opt-in and synced=1", async () => {
  const f = fixture({ running: () => true });
  await expect(f.repository.updateNote({ ...f.params(), content: "Blocked" })).rejects.toThrow("UpNote is running");
  f.db.exec("UPDATE notes SET synced=0 WHERE id='note-a'");
  await expect(f.repository.updateNote({ ...f.params(), content: "Blocked", allowWhileRunning: true })).rejects.toThrow("pending sync");
  expect(existsSync(f.backupsDir)).toBe(false);
});

test("opted-in live edit writes with warnings and never claims sync success", async () => {
  const f = fixture({ running: () => true });
  const result = await f.repository.updateNote({ ...f.params(), content: "Live", allowWhileRunning: true });
  expect(result.committed).toBe(true);
  expect(result.appRunning).toBe(true);
  expect(result.databaseVerification).toBe("matches");
  expect(result.cloudSync).toBe("unverified");
  expect(result.warnings.join(" ")).toContain("may overwrite");
});

test("post-commit overwrite is reported as a conflict without an automatic retry", async () => {
  const f = fixture({ running: () => true, observeLiveMs: 300 });
  const edit = f.repository.updateNote({ ...f.params(), content: "Live", allowWhileRunning: true });
  f.db.exec("UPDATE notes SET html='<h2>Cached title</h2>', revision=revision+1 WHERE id='note-a'");
  const result = await edit;
  expect(result.committed).toBe(true);
  expect(result.databaseVerification).toBe("conflict");
  expect(f.row().html).toBe("<h2>Cached title</h2>");
  expect(readdirSync(f.backupsDir)).toHaveLength(1);
});

test("backup failure leaves the original untouched and releases the write lock", async () => {
  const f = fixture();
  const before = f.row();
  writeFileSync(f.backupsDir, "not a directory");
  await expect(f.repository.updateNote({ ...f.params(), content: "Never commit" })).rejects.toThrow("Edit not committed");
  expect(f.row()).toEqual(before);
  f.db.exec("BEGIN IMMEDIATE; ROLLBACK");
});

test("SQL failure rolls back after backup and retains the backup", async () => {
  const f = fixture();
  const before = f.row();
  f.db.exec("CREATE TRIGGER reject_edit BEFORE UPDATE ON notes BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  await expect(f.repository.updateNote({ ...f.params(), content: "Never commit" })).rejects.toThrow("Edit not committed");
  expect(f.row()).toEqual(before);
  expect(readdirSync(f.backupsDir)).toHaveLength(1);
});

test("concurrent SQLite writer prevents editing without changing or backing up data", async () => {
  const f = fixture();
  const before = f.row();
  f.db.exec("BEGIN IMMEDIATE");
  try {
    await expect(f.repository.updateNote({ ...f.params(), content: "Blocked" })).rejects.toThrow();
    expect(f.row()).toEqual(before);
    expect(existsSync(f.backupsDir)).toBe(false);
  } finally { f.db.exec("ROLLBACK"); }
});

test("app starting during preflight is detected and prevents writes", async () => {
  let calls = 0;
  const f = fixture({ running: () => ++calls >= 3 });
  const before = f.row();
  await expect(f.repository.updateNote({ ...f.params(), content: "Blocked" })).rejects.toThrow("UpNote is running");
  expect(f.row()).toEqual(before);
});

test("version is rechecked after process detection and obtaining the writer lock", async () => {
  let calls = 0;
  let change = () => {};
  const f = fixture({ running: () => { if (++calls === 2) change(); return false; } });
  change = () => { f.db.exec("UPDATE notes SET text='External edit' WHERE id='note-a'"); };
  const params = f.params();
  await expect(f.repository.updateNote({ ...params, content: "Blocked" })).rejects.toThrow("changed since get_note");
  expect(f.row().text).toBe("External edit");
  expect(existsSync(f.backupsDir)).toBe(false);
});

test("append preserves existing attachment HTML and metadata; replacement refuses it", async () => {
  const f = fixture();
  f.db.exec(`UPDATE notes SET html='<h2>Old title</h2><p><img src="file://image.png"></p>', filesCount=1, fileIds='["image-a"]', firstImage='image-a' WHERE id='note-a'`);
  const before = f.row();
  await expect(f.repository.updateNote({ ...f.params(), content: "Replacement" })).rejects.toThrow("attachments/images");
  const result = await f.repository.updateNote({ ...f.params(), content: "Appendix", mode: "append" });
  expect(result.committed).toBe(true);
  expect(String(f.row().html).startsWith(String(before.html))).toBe(true);
  for (const field of ["fileIds", "filesCount", "firstImage"]) expect(f.row()[field]).toEqual(before[field]);
});

test("title-only rename keeps body markup and updates the embedded title", async () => {
  const f = fixture();
  const result = await f.repository.updateNote({ ...f.params(), title: "Renamed" });
  expect(result.committed).toBe(true);
  expect(f.row().html).toBe("<h2>Renamed</h2><p>Old body</p>");
  expect(f.row().text).toBe("Renamed\nOld body");
});

test("append leaves a formatted title untouched and text mode escapes markup", async () => {
  const f = fixture();
  f.db.exec(`UPDATE notes SET html='<h2><strong>Old title</strong></h2><p>Old body</p>' WHERE id='note-a'`);
  await f.repository.updateNote({ ...f.params(), title: "Old title", content: "<b>plain</b>\nsecond", contentFormat: "text", mode: "append" });
  expect(f.row().html).toContain("<h2><strong>Old title</strong></h2>");
  expect(f.row().html).toContain("&lt;b&gt;plain&lt;/b&gt;");
  expect(f.row().text).toContain("<b>plain</b>\nsecond");
});

test("failed read-back reports the committed edit and backup without retrying", async () => {
  const f = fixture({ running: () => true, observeLiveMs: 300 });
  const edit = f.repository.updateNote({ ...f.params(), content: "Committed", allowWhileRunning: true });
  f.repository.close();
  const result = await edit;
  expect(result.committed).toBe(true);
  expect(result.databaseVerification).toBe("unavailable");
  expect(result.note).toBeNull();
  expect(result.backupPath).not.toBeNull();
  expect(f.row().text).toContain("Committed");
});

test("no-op and invalid edits never create backups", async () => {
  const f = fixture();
  expect((await f.repository.updateNote({ ...f.params(), title: "Old title" })).committed).toBe(false);
  for (const params of [
    { ...f.params() }, { ...f.params(), title: "" }, { ...f.params(), title: "a\nb" },
    { ...f.params(), content: "", mode: "append" as const },
    { ...f.params(), id: "missing", content: "Body" },
  ]) await expect(f.repository.updateNote(params)).rejects.toThrow();
  expect(existsSync(f.backupsDir)).toBe(false);
});

test("deleted and trashed notes are refused", async () => {
  for (const flag of ["deleted", "trashed"]) {
    const f = fixture();
    const params = f.params();
    f.db.exec(`UPDATE notes SET ${flag}=1 WHERE id='note-a'`);
    await expect(f.repository.updateNote({ ...params, content: "Blocked" })).rejects.toThrow("Active note not found");
  }
});

test("detector errors fail closed and schema mismatch never writes", async () => {
  const f = fixture({ running: () => { throw new Error("detector unavailable"); } });
  await expect(f.repository.updateNote({ ...f.params(), content: "Blocked" })).rejects.toThrow("detector unavailable");
  const other = fixture();
  other.db.exec("ALTER TABLE notes DROP COLUMN revision");
  await expect(other.repository.updateNote({ ...other.params(), content: "Blocked" })).rejects.toThrow("missing notes.revision");
  expect(existsSync(other.backupsDir)).toBe(false);
});

test("body clearing is explicit and Markdown cannot import images, raw HTML or script links", async () => {
  const f = fixture();
  await f.repository.updateNote({ ...f.params(), content: "", contentFormat: "text" });
  expect(f.row().text).toBe("Old title");
  expect(() => renderBody("![img](https://example.com/a.png)", "markdown")).toThrow("images");
  expect(() => renderBody("[bad](javascript:alert(1))", "markdown")).toThrow("protocol");
  expect(renderBody('<script>alert(1)</script>', "markdown")).not.toContain("<script>");
  expect(htmlToPlainText('<p>&copy; A &amp; B</p><p>line<br>two</p>')).toBe("© A & B\nline\ntwo");
});

test("app-native preparation snapshots and stages HTML without updating UpNote rows", async () => {
  let staged: Record<string, string> | undefined;
  const f = fixture({ running: () => true, stageClipboard: async (path) => { staged = JSON.parse(readFileSync(path, "utf8")); } });
  const before = f.row();
  const plan = await f.repository.prepareAppNoteEdit({ ...f.params(), content: "**Native** & test" });
  expect(f.row()).toEqual(before);
  expect(staged?.kind).toBe("upnote-app-edit-v1");
  expect(staged?.html).toContain("<strong>Native</strong>");
  expect(plan.proposed.text).toContain("Native & test");
  expect(plan.clipboardStaged).toBe(true);
  const backup = new Database(plan.backupPath, { readonly: true, create: false });
  try { expect(backup.query("SELECT * FROM notes WHERE id='note-a'").get()).toEqual(before); }
  finally { backup.close(); }
  expect((await f.repository.completeAppNoteEdit(plan.ticket, 0)).state).toBe("awaiting_edit");
});

test("app-native completion requires matching content and a fresh app sync timestamp", async () => {
  const f = fixture({ running: () => true });
  f.db.exec("ALTER TABLE notes ADD COLUMN syncedAt DOUBLE DEFAULT 1");
  const plan = await f.repository.prepareAppNoteEdit({ ...f.params(), content: "Native sync" });
  f.db.query("UPDATE notes SET html=?, text=?, title=?, synced=0, updatedAt=? WHERE id='note-a'")
    .run(plan.proposed.html, plan.proposed.text, plan.proposed.title, Date.now());
  const local = await f.repository.completeAppNoteEdit(plan.ticket, 0);
  expect(local.state).toBe("awaiting_sync");
  expect(local.applied).toBe(true);
  expect(local.cloudSync).toBe("unverified");
  f.db.exec("UPDATE notes SET synced=1 WHERE id='note-a'");
  expect((await f.repository.completeAppNoteEdit(plan.ticket, 0)).state).toBe("awaiting_sync");
  f.db.query("UPDATE notes SET syncedAt=? WHERE id='note-a'").run(Date.now());
  const complete = await f.repository.completeAppNoteEdit(plan.ticket, 0);
  expect(complete.state).toBe("synced");
  expect(complete.cloudSync).toBe("app_acknowledged");
  expect(complete.otherDeviceVerified).toBe(false);
});

test("app-native completion detects wrong content and deleted targets without retrying", async () => {
  const f = fixture({ running: () => true });
  const plan = await f.repository.prepareAppNoteEdit({ ...f.params(), content: "Expected" });
  f.db.exec("UPDATE notes SET text='Unexpected' WHERE id='note-a'");
  expect((await f.repository.completeAppNoteEdit(plan.ticket, 0)).state).toBe("conflict");
  expect(f.row().text).toBe("Unexpected");
  f.db.exec("UPDATE notes SET trashed=1 WHERE id='note-a'");
  expect((await f.repository.completeAppNoteEdit(plan.ticket, 0)).state).toBe("conflict");
  await expect(f.repository.completeAppNoteEdit("unknown", 0)).rejects.toThrow("Unknown or expired");
});

test("app-native preparation refuses stale, unsynced and attachment notes", async () => {
  const f = fixture({ running: () => true });
  const stale = f.params();
  f.db.exec("UPDATE notes SET pinned=0 WHERE id='note-a'");
  await expect(f.repository.prepareAppNoteEdit({ ...stale, content: "No" })).rejects.toThrow("changed");
  f.db.exec("UPDATE notes SET synced=0 WHERE id='note-a'");
  await expect(f.repository.prepareAppNoteEdit({ ...f.params(), content: "No" })).rejects.toThrow("synced");
  f.db.exec("UPDATE notes SET synced=1,filesCount=1 WHERE id='note-a'");
  await expect(f.repository.prepareAppNoteEdit({ ...f.params(), content: "No", mode: "append" })).rejects.toThrow("images/attachments");
  expect(existsSync(f.backupsDir)).toBe(false);
});

test("clipboard staging failure leaves the library unchanged and retains its backup", async () => {
  const f = fixture({ running: () => true, stageClipboard: async () => { throw new Error("clipboard busy"); } });
  const before = f.row();
  await expect(f.repository.prepareAppNoteEdit({ ...f.params(), content: "No" })).rejects.toThrow("clipboard busy");
  expect(f.row()).toEqual(before);
  expect(readdirSync(f.backupsDir)).toHaveLength(1);
});

function nativeChannel(apply: () => void, check: () => void = () => {}): NativeChannel {
  return {
    async evaluate<T>(expression: string): Promise<T> {
      if (expression.includes('"action":"apply"')) { apply(); return { accepted: true } as T; }
      if (expression.includes('"action":"check"')) check();
      return { editorMatches: true } as T;
    },
    close() {},
  };
}

test("native repository backs up before the app action and verifies fresh sync acknowledgement", async () => {
  let calls = 0;
  const f = fixture({ connectNative: async () => nativeChannel(() => {
    calls++;
    const now = Date.now();
    f.db.query("UPDATE notes SET html=?,text=?,updatedAt=?,syncedAt=?,synced=1,revision=revision+1 WHERE id='note-a'")
      .run("<h2>Old title</h2><p>Native body</p>", "Old title\nNative body", now, now);
  }) });
  const before = f.row();
  const result = await f.repository.updateNoteInApp({ ...f.params(), content: "Native body" }, 0);
  expect(calls).toBe(1);
  expect(result.state).toBe("synced");
  expect(result.cloudSync).toBe("app_acknowledged");
  expect(result.uiUpdated).toBe(true);
  expect(result.otherDeviceVerified).toBe(false);
  expect(f.row().id).toBe(before.id);
  const backup = new Database(result.backupPath!, { readonly: true, create: false });
  try { expect(backup.query("SELECT * FROM notes WHERE id='note-a'").get()).toEqual(before); }
  finally { backup.close(); }
});

test("native backup failure or failed preflight never invokes the app mutation", async () => {
  let calls = 0;
  const backupFailure = fixture({ connectNative: async () => nativeChannel(() => { calls++; }) });
  const before = backupFailure.row();
  writeFileSync(backupFailure.backupsDir, "file instead of directory");
  await expect(backupFailure.repository.updateNoteInApp({ ...backupFailure.params(), content: "No" }, 0)).rejects.toThrow();
  expect(backupFailure.row()).toEqual(before);
  const preflightFailure = fixture({ connectNative: async () => nativeChannel(() => { calls++; }, () => { throw new Error("unsaved UI"); }) });
  await expect(preflightFailure.repository.updateNoteInApp({ ...preflightFailure.params(), content: "No" }, 0)).rejects.toThrow("unsaved UI");
  expect(existsSync(preflightFailure.backupsDir)).toBe(false);
  expect(calls).toBe(0);
});

test("a lost native response is an unknown outcome with a retained backup and no retry", async () => {
  let calls = 0;
  const f = fixture({ connectNative: async () => nativeChannel(() => {
    calls++; f.db.exec("UPDATE notes SET text='App saved before disconnect' WHERE id='note-a'"); throw new Error("lost response");
  }) });
  const result = await f.repository.updateNoteInApp({ ...f.params(), content: "Native body" }, 0);
  expect(result.applied).toBeNull();
  expect(result.state).toBe("unavailable");
  expect(result.note).toBeNull();
  expect(result.backupPath).not.toBeNull();
  expect(calls).toBe(1);
  expect(f.row().text).toBe("App saved before disconnect");
});

test("native dry run previews without backup or app mutation", async () => {
  let calls = 0;
  const f = fixture({ connectNative: async () => nativeChannel(() => { calls++; }) });
  const result = await f.repository.updateNoteInApp({ ...f.params(), content: "Preview", dryRun: true }, 0);
  expect(result.applied).toBe(false);
  expect(result.preview?.content).toContain("Preview");
  expect(result.backupPath).toBeNull();
  expect(existsSync(f.backupsDir)).toBe(false);
  expect(calls).toBe(0);
});

test("native schema checks accept added columns and a unique ID index in place of the primary key", async () => {
  const f = fixture({ connectNative: async () => nativeChannel(() => { throw new Error("Dry run must not mutate"); }) });
  f.db.exec("ALTER TABLE notes RENAME TO old_notes; CREATE TABLE notes AS SELECT * FROM old_notes; CREATE UNIQUE INDEX unique_note_id ON notes(id); ALTER TABLE notes ADD COLUMN new_app_field BLOB");
  const result = await f.repository.updateNoteInApp({ ...f.params(), content: "Preview", dryRun: true }, 0);
  expect(result.compatibility.database.compatible).toBe(true);
  expect(result.compatibility.database.extraColumnsAllowed).toBe(true);
  expect(result.backupPath).toBeNull();
});

test("native schema changes fail before backup or app action and are rechecked on every call", async () => {
  for (const [change, reason] of [
    ["ALTER TABLE notes DROP COLUMN syncedAt", "missing notes.syncedAt"],
    ["ALTER TABLE notes RENAME COLUMN id TO legacy_id", "missing notes.id"],
    ["ALTER TABLE notes RENAME TO old_notes; CREATE TABLE notes AS SELECT * FROM old_notes", "unique index"],
    ["ALTER TABLE notes RENAME TO old_notes; CREATE TABLE notes AS SELECT * FROM old_notes; CREATE UNIQUE INDEX partial_id ON notes(id) WHERE deleted=0", "unique index"],
    ["ALTER TABLE notes RENAME TO old_notes; CREATE TABLE notes AS SELECT * FROM old_notes; CREATE UNIQUE INDEX composite_id ON notes(id,title)", "unique index"],
    ["ALTER TABLE notes DROP COLUMN summary; ALTER TABLE notes ADD COLUMN summary TEXT GENERATED ALWAYS AS (title) VIRTUAL", "non-generated"],
  ]) {
    let calls = 0;
    const f = fixture({ connectNative: async () => nativeChannel(() => { calls++; }) });
    await f.repository.updateNoteInApp({ ...f.params(), content: "Preview", dryRun: true }, 0);
    const params = f.params();
    f.db.exec(change!);
    await expect(f.repository.updateNoteInApp({ ...params, content: "Must not write" }, 0)).rejects.toThrow(reason!);
    expect(calls).toBe(0);
    expect(existsSync(f.backupsDir)).toBe(false);
  }
});

test("native malformed row data and schema changes during preflight cannot reach the app action", async () => {
  let calls = 0;
  const badValue = fixture({ connectNative: async () => nativeChannel(() => { calls++; }) });
  badValue.db.exec("UPDATE notes SET revision='unexpected string' WHERE id='note-a'");
  await expect(badValue.repository.updateNoteInApp({ ...badValue.params(), content: "No" }, 0)).rejects.toThrow("revision");
  const midFlight = fixture({ connectNative: async () => nativeChannel(() => { calls++; }, () => { midFlight.db.exec("ALTER TABLE notes DROP COLUMN syncedAt"); }) });
  await expect(midFlight.repository.updateNoteInApp({ ...midFlight.params(), content: "No" }, 0)).rejects.toThrow("missing notes.syncedAt");
  expect(calls).toBe(0);
  expect(existsSync(badValue.backupsDir)).toBe(false);
  expect(existsSync(midFlight.backupsDir)).toBe(false);
});

test("automatic connection recovery never retries a mutation whose response was lost", async () => {
  let launches = 0; let mutations = 0;
  const f = fixture({ autoStart: true, startNativeApp: async () => { launches++; }, connectNative: async () => nativeChannel(() => {
    mutations++; throw new NativeConnectionUnavailable("disconnected during app edit");
  }) });
  const result = await f.repository.updateNoteInApp({ ...f.params(), content: "No repeated edit" }, 0);
  expect(result.applied).toBeNull(); expect(result.state).toBe("unavailable");
  expect(mutations).toBe(1); expect(launches).toBe(0);
});

test("partial native batches preserve rich HTML/attachment references, use one backup and return compact results", async () => {
  let calls = 0;
  const html = '<h2>Old title</h2><h2>A</h2><p><b>old</b> text</p><h2>B</h2><p>section</p><h2>C</h2><div style="color:red"><img src="keep">UNCHANGED-SENTINEL</div>';
  const expected = html.replace("<b>old</b>", "<b>new</b>").replace("<p>section</p>", "\n<p>new section</p>");
  const f = fixture({ connectNative: async () => nativeChannel(() => {
    calls++; const now = Date.now();
    f.db.query("UPDATE notes SET html=?,text=?,synced=1,syncedAt=?,updatedAt=?,revision=revision+1 WHERE id='note-a'").run(expected, htmlToPlainText(expected), now, now);
  }) });
  f.db.query("UPDATE notes SET html=?,text=?,filesCount=1,fileIds='[\"image-a\"]',firstImage='image-a' WHERE id='note-a'").run(html, htmlToPlainText(html));
  const before = f.row();
  const result = await f.repository.patchNoteInApp({ ...f.params(), operations: [
    { type: "replace_text", find: "old", replacement: "new" },
    { type: "replace_section", section: { heading: "B" }, content: "new section", contentFormat: "text" },
  ], waitMs: 0 });
  expect(result.state).toBe("synced"); expect(result.htmlPreserved).toBe(true); expect(result.changes).toHaveLength(2);
  expect(calls).toBe(1); expect(readdirSync(f.backupsDir)).toHaveLength(1);
  expect(f.row().html).toBe(expected); expect(f.row().fileIds).toBe(before.fileIds); expect(f.row().firstImage).toBe(before.firstImage);
  expect("note" in result).toBe(false); expect("preview" in result).toBe(false);
  expect(JSON.stringify(result)).not.toContain("UNCHANGED-SENTINEL");
  const backup = new Database(result.backupPath!, { readonly: true, create: false });
  try { expect(backup.query("SELECT * FROM notes WHERE id='note-a'").get()).toEqual(before); } finally { backup.close(); }
});

test("invalid batches, stale versions and partial dry runs cannot mutate or create backups", async () => {
  let calls = 0;
  const f = fixture({ connectNative: async () => nativeChannel(() => { calls++; }) });
  const before = f.row();
  await expect(f.repository.patchNoteInApp({ ...f.params(), operations: [
    { type: "replace_text", find: "Old body", replacement: "new" }, { type: "replace_text", find: "missing", replacement: "bad" },
  ] })).rejects.toThrow("count differs");
  const preview = await f.repository.patchNoteInApp({ ...f.params(), dryRun: true, operations: [{ type: "replace_text", find: "Old body", replacement: "preview" }] });
  expect(preview.applied).toBe(false); expect(preview.htmlPreserved).toBeNull(); expect(preview.changes).toHaveLength(1);
  expect(f.row()).toEqual(before); expect(calls).toBe(0); expect(existsSync(f.backupsDir)).toBe(false);
  const stale = f.params(); f.db.exec("UPDATE notes SET pinned=0 WHERE id='note-a'");
  await expect(f.repository.patchNoteInApp({ ...stale, operations: [{ type: "replace_text", find: "Old body", replacement: "no" }] })).rejects.toThrow("changed");
  expect(calls).toBe(0); expect(existsSync(f.backupsDir)).toBe(false);
});

test("partial editing reports a conflict if the app rewrites planned HTML despite matching text", async () => {
  const f = fixture({ connectNative: async () => nativeChannel(() => {
    const now = Date.now(); f.db.query("UPDATE notes SET html=?,text=?,synced=1,syncedAt=?,updatedAt=? WHERE id='note-a'").run('<h2>Old title</h2><div>new</div>', 'Old title\nnew', now, now);
  }) });
  const result = await f.repository.patchNoteInApp({ ...f.params(), waitMs: 0, operations: [{ type: "replace_text", find: "Old body", replacement: "new" }] });
  expect(result.applied).toBe(true); expect(result.htmlPreserved).toBe(false); expect(result.state).toBe("conflict"); expect(result.backupPath).not.toBeNull();
});

test("partial backup failure and lost native responses never cause mutation retries", async () => {
  let calls = 0;
  const f = fixture({ connectNative: async () => nativeChannel(() => { calls++; throw new NativeConnectionUnavailable("lost"); }) });
  const result = await f.repository.patchNoteInApp({ ...f.params(), operations: [{ type: "replace_text", find: "Old body", replacement: "new" }] });
  expect(calls).toBe(1); expect(result.applied).toBeNull(); expect(result.version).toBeNull(); expect(result.htmlPreserved).toBeNull();
  const blocked = fixture({ connectNative: async () => nativeChannel(() => { calls++; }) });
  writeFileSync(blocked.backupsDir, "blocked");
  await expect(blocked.repository.patchNoteInApp({ ...blocked.params(), operations: [{ type: "replace_text", find: "Old body", replacement: "new" }] })).rejects.toThrow();
  expect(calls).toBe(1);
});
