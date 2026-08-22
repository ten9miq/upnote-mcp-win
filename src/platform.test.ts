import { expect, test } from "bun:test";
import { join } from "node:path";
import { getUpNoteUrlOpenerCommand } from "./url";
import { resolveUpnoteDbPath, UpNoteRepository } from "./upnote";

test("UPNOTE_DB overrides every platform default", () => {
  expect(resolveUpnoteDbPath({
    platform: "win32",
    homeDir: "C:\\Users\\test",
    env: { UPNOTE_DB: "D:\\custom\\upnote.sqlite3", APPDATA: "C:\\ignored" },
  })).toBe("D:\\custom\\upnote.sqlite3");
});

test("Windows defaults to APPDATA\\UpNote\\upnote.sqlite3", () => {
  expect(resolveUpnoteDbPath({
    platform: "win32",
    env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
  })).toBe("C:\\Users\\test\\AppData\\Roaming\\UpNote\\upnote.sqlite3");
});

test("macOS keeps the existing container path", () => {
  expect(resolveUpnoteDbPath({
    platform: "darwin",
    homeDir: "C:\\Users\\test",
    env: {},
  })).toContain("Library\\Containers\\com.getupnote.desktop");
});

test("Windows URL opening passes the URL as an argument", () => {
  const url = "upnote://x-callback-url/note/new?title=one%26two&text=a%3Db";
  expect(getUpNoteUrlOpenerCommand(url, "win32")).toEqual([
    "rundll32.exe",
    "url.dll,FileProtocolHandler",
    url,
  ]);
});

test("a missing database error includes the checked path", () => {
  const missingPath = join(import.meta.dir, "does-not-exist.sqlite3");
  expect(() => new UpNoteRepository(missingPath)).toThrow(`Checked path: ${missingPath}`);
});
