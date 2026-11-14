import { expect, test } from "bun:test";
import vm from "node:vm";
import { loopbackEndpoint, nativeExpression } from "./native-bridge";

test("native endpoint is restricted to literal loopback HTTP origins", () => {
  expect(loopbackEndpoint("http://127.0.0.1:19330").hostname).toBe("127.0.0.1");
  expect(loopbackEndpoint("http://[::1]:19330").hostname).toBe("[::1]");
  for (const url of ["https://127.0.0.1", "http://localhost", "http://example.com", "http://user:password@127.0.0.1", "http://127.0.0.1/path", "http://127.0.0.1?x=1"]) expect(() => loopbackEndpoint(url)).toThrow();
});

function runtimeFixture() {
  const path = "C:\\fixture\\upnote.sqlite3";
  let record: Record<string, any> = { id: "test-id", title: "Title", text: "Title\nBefore", html: "<h2>Title</h2><p>Before</p>", summary: "Before", createdAt: 1, updatedAt: 10, syncedAt: 5, revision: 2, synced: true, deleted: false, trashed: false, hasTodo: false, filesCount: 0, fileIds: new Set(), space: null };
  const before: Record<string, any> = { ...record, synced: 1, deleted: 0, trashed: 0, hasTodo: 0, fileIds: "[]" };
  let updates = 0;
  const store: any = {
    localDataLoaded: true, isCurrentNoteModified: false, spaceId: "", currentWorkspaceLocked: false,
    current: { noteId: "other", mode: "notes-all" },
    get currentNoteId() { return this.current.noteId; },
    getLockedNoteIdsInAllSpaces: new Set(), notes: new Map([[record.id, { ...record }]]),
    setNavigationState(value: unknown) { this.current = value; },
    updateNotes(patches: Array<Record<string, unknown>>) { updates++; record = { ...record, ...patches[0], revision: record.revision + 1, synced: false }; this.notes.set(record.id, { ...record }); },
  };
  const lock = { shouldShowAppLock: false, shouldShowPartialLock: false };
  const ui = { setSelectedNoteId() {} };
  const stores = new Map<string, any>([["coreStore", store], ["uiStore", ui], ["lockStore", lock], ["staticStore", { appVersion: "9.22.9" }]]);
  const sql: any = { getLocation: () => path, get: () => record };
  const context = vm.createContext({ Set, Map, document: {
    querySelector: () => ({ __vue_app__: { config: { globalProperties: { $pinia: { _s: stores } } } } }),
    querySelectorAll: () => [{ isConnected: true, textContent: record.text }],
  }, upnote: { sqlPreload: sql } });
  const run = (action: "status" | "check" | "apply" | "verify", patch?: Record<string, string | number>, databasePath = path) => vm.runInContext(nativeExpression({ action, databasePath, expected: before, patch }), context);
  return { run, store, ui, sql, lock, stores, before, row: () => record, updates: () => updates };
}

test("native action calls the app store, preserves identity and verifies its editor", async () => {
  const f = runtimeFixture();
  const patch = { title: "Title", text: 'Title\n日本語 ");throw new Error("injection")//', html: "<h2>Title</h2><p>日本語</p>" };
  await f.run("check");
  expect(f.updates()).toBe(0);
  expect((await f.run("apply", patch)).accepted).toBe(true);
  expect(f.updates()).toBe(1);
  expect(f.row().text).toBe(patch.text);
  expect(f.row().id).toBe(f.before.id);
  expect(f.row().createdAt).toBe(1);
  expect((await f.run("verify", patch)).editorMatches).toBe(true);
});

test("native action fails closed for locks, unsaved changes, stale app cache and wrong profiles", async () => {
  const locked = runtimeFixture(); locked.lock.shouldShowAppLock = true;
  await expect(locked.run("apply", { text: "No" })).rejects.toThrow("Unlock");
  const unsaved = runtimeFixture(); unsaved.store.isCurrentNoteModified = true;
  await expect(unsaved.run("apply", { text: "No" })).rejects.toThrow("unsaved");
  const stale = runtimeFixture(); stale.store.notes.get("test-id").revision = 1;
  await expect(stale.run("apply", { text: "No" })).rejects.toThrow("stale");
  const wrongProfile = runtimeFixture();
  await expect(wrongProfile.run("apply", { text: "No" }, "D:/other.sqlite3")).rejects.toThrow("different");
  for (const f of [locked, unsaved, stale, wrongProfile]) expect(f.updates()).toBe(0);
});

test("native action accepts unknown future versions when required capabilities are unchanged", async () => {
  for (const version of ["9.22.10", "10.0.0", "custom-build"]) {
    const f = runtimeFixture(); f.stores.get("staticStore").appVersion = version;
    const result = await f.run("check");
    expect(result.appVersion).toBe(version);
    expect(result.compatibility.compatible).toBe(true);
    expect(result.compatibility.versionPolicy).toBe("informational-only");
    expect((await f.run("apply", { text: "New version" })).accepted).toBe(true);
  }
  const missingVersion = runtimeFixture(); missingVersion.stores.delete("staticStore");
  expect((await missingVersion.run("check")).appVersion).toBeNull();
});

test("native action still refuses locked notes and sync flag mutations", async () => {
  const note = runtimeFixture(); note.store.getLockedNoteIdsInAllSpaces.add("test-id");
  await expect(note.run("check")).rejects.toThrow("locked");
  const flags = runtimeFixture();
  await expect(flags.run("apply", { synced: 1 })).rejects.toThrow("Unsupported native edit field");
  expect(flags.updates()).toBe(0);
});

test("all required native methods are checked before any update", async () => {
  for (const [owner, method] of [["store", "updateNotes"], ["store", "setNavigationState"], ["ui", "setSelectedNoteId"], ["sql", "getLocation"], ["sql", "get"]] as const) {
    const f = runtimeFixture(); delete f[owner][method];
    await expect(f.run("apply", { text: "No" })).rejects.toThrow(`.${method}()`);
    expect(f.updates()).toBe(0);
  }
});

test("missing or malformed lock, loading and unsaved state fails closed", async () => {
  for (const field of ["localDataLoaded", "isCurrentNoteModified", "currentWorkspaceLocked"]) {
    const f = runtimeFixture(); delete f.store[field];
    await expect(f.run("apply", { text: "No" })).rejects.toThrow(`coreStore.${field}`);
    expect(f.updates()).toBe(0);
  }
  for (const field of ["shouldShowAppLock", "shouldShowPartialLock"] as const) {
    const f = runtimeFixture(); (f.lock as any)[field] = "false";
    await expect(f.run("apply", { text: "No" })).rejects.toThrow(`lockStore.${field}`);
    expect(f.updates()).toBe(0);
  }
});

test("native return shapes and note data types are verified rather than truthiness-coerced", async () => {
  const cases: Array<[string, (f: ReturnType<typeof runtimeFixture>) => void]> = [
    ["path string", f => { f.sql.getLocation = () => 123; }],
    ["locked-note lookup", f => { f.store.getLockedNoteIdsInAllSpaces = undefined; }],
    ["navigation state", f => { f.store.current = {}; }],
    ["coreStore.notes", f => { f.store.notes = {}; }],
    ["synced", f => { f.row().synced = "false"; }],
    ["revision", f => { f.row().revision = "2"; }],
    ["fileIds", f => { f.row().fileIds = {}; }],
    ["id", f => { f.sql.get = async () => f.row(); }],
  ];
  for (const [reason, mutate] of cases) {
    const f = runtimeFixture(); mutate(f);
    await expect(f.run("apply", { text: "No" })).rejects.toThrow(reason);
    expect(f.updates()).toBe(0);
  }
});

test("compatible native actions may return promises; navigation is verified before saving", async () => {
  const f = runtimeFixture();
  const navigate = f.store.setNavigationState.bind(f.store);
  const update = f.store.updateNotes.bind(f.store);
  f.store.setNavigationState = async (value: unknown) => { await Promise.resolve(); navigate(value); };
  f.ui.setSelectedNoteId = async () => { await Promise.resolve(); };
  f.store.updateNotes = async (patches: unknown) => { await Promise.resolve(); update(patches); };
  expect((await f.run("apply", { text: "Async compatible" })).accepted).toBe(true);
  expect(f.row().text).toBe("Async compatible");
  const wrongNavigation = runtimeFixture(); wrongNavigation.store.setNavigationState = () => {};
  await expect(wrongNavigation.run("apply", { text: "No" })).rejects.toThrow("navigation did not select");
  expect(wrongNavigation.updates()).toBe(0);
});

test("async navigation cannot hide new unsaved edits before the native save", async () => {
  const f = runtimeFixture();
  f.ui.setSelectedNoteId = async () => { f.store.isCurrentNoteModified = true; };
  await expect(f.run("apply", { text: "No" })).rejects.toThrow("unsaved");
  expect(f.updates()).toBe(0);
});
