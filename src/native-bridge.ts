import { assertNativeNoteData } from "./compatibility";

export function loopbackEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("UPNOTE_CDP_URL must be a plain HTTP loopback origin such as http://127.0.0.1:19330.");
  }
  return url;
}

type Target = { id: string; type: string; url: string; webSocketDebuggerUrl: string };
export type NativeChannel = { evaluate<T>(expression: string, timeoutMs?: number): Promise<T>; close(): void };
export class NativeConnectionUnavailable extends Error {}

export class NativeConnection {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(`CDP: ${message.error.message}`));
        else request.resolve(message.result);
      } catch { this.fail(new Error("Invalid CDP response.")); }
    });
    socket.addEventListener("close", () => this.fail(new NativeConnectionUnavailable("UpNote CDP connection closed. Do not automatically retry a mutation.")));
    socket.addEventListener("error", () => this.fail(new NativeConnectionUnavailable("UpNote CDP transport error. Do not automatically retry a mutation.")));
  }

  static async connect(endpoint: string): Promise<NativeConnection> {
    const base = loopbackEndpoint(endpoint);
    const get = async (path: string) => {
      let response: Response;
      try { response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(3000), redirect: "error" }); }
      catch (error) { throw new NativeConnectionUnavailable(`Cannot reach UpNote CDP: ${String(error)}`); }
      if (!response.ok) throw new Error(`CDP discovery returned HTTP ${response.status}`);
      return response.json();
    };
    const version = await get("/json/version") as Record<string, string>;
    if (!/UpNote\//.test(version["User-Agent"] ?? "")) throw new Error("The endpoint does not identify itself as UpNote.");
    const targets = await get("/json/list") as Target[];
    if (targets.some((target) => {
      try {
        const url = new URL(target.url);
        return target.type === "page" && url.searchParams.has("noteWindowId") && url.searchParams.get("noteWindowId") !== "PRELOAD_NOTE_WINDOW";
      } catch { return false; }
    })) throw new Error("Close UpNote pop-out note windows before a native edit; they may contain unsaved changes.");
    const main = targets.filter((target) => {
      try {
        const url = new URL(target.url);
        return target.type === "page" && url.protocol === "file:" && !url.search && /\/[^/]*UpNote[^/]*\/app\/resources\/app\.asar\/dist\/electron\/index\.html$/i.test(decodeURIComponent(url.pathname));
      } catch { return false; }
    });
    if (main.length === 0) throw new NativeConnectionUnavailable("UpNote's main renderer is not ready yet.");
    if (main.length !== 1) throw new Error(`Expected one UpNote main renderer; found ${main.length}.`);
    const socketUrl = new URL(main[0]!.webSocketDebuggerUrl);
    if (socketUrl.protocol !== "ws:" || socketUrl.hostname !== base.hostname || socketUrl.port !== base.port || socketUrl.username || socketUrl.password || socketUrl.pathname !== `/devtools/page/${main[0]!.id}`) {
      throw new Error("CDP returned a non-local or mismatched WebSocket address.");
    }
    return NativeConnection.openSocket(socketUrl);
  }

  static async verifyOwner(endpoint: string, expectedPid: number): Promise<void> {
    const base = loopbackEndpoint(endpoint);
    if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) throw new Error("Expected a valid UpNote process ID.");
    const response = await fetch(new URL("/json/version", base), { signal: AbortSignal.timeout(3000), redirect: "error" });
    if (!response.ok) throw new Error("Cannot inspect UpNote CDP ownership.");
    const version = await response.json() as Record<string, string>;
    if (!/UpNote\//.test(version["User-Agent"] ?? "")) throw new Error("The CDP endpoint does not identify itself as UpNote.");
    const socketUrl = new URL(version.webSocketDebuggerUrl!);
    if (socketUrl.protocol !== "ws:" || socketUrl.hostname !== base.hostname || socketUrl.port !== base.port || socketUrl.username || socketUrl.password || !/^\/devtools\/browser\/[a-z\d-]+$/i.test(socketUrl.pathname)) {
      throw new Error("CDP returned an invalid browser endpoint.");
    }
    const connection = await NativeConnection.openSocket(socketUrl);
    try {
      const processes = await connection.request("SystemInfo.getProcessInfo") as { processInfo?: Array<{ type: string; id: number }> };
      const browser = processes.processInfo?.filter(item => item.type === "browser");
      if (browser?.length !== 1 || browser[0]!.id !== expectedPid) throw new Error("The CDP endpoint belongs to a different browser process.");
    } finally { connection.close(); }
  }

  private static async openSocket(socketUrl: URL): Promise<NativeConnection> {
    const socket = new WebSocket(socketUrl);
    const connection = new NativeConnection(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new NativeConnectionUnavailable("UpNote CDP connection timed out.")); }, 3000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new NativeConnectionUnavailable("Cannot open UpNote CDP connection.")); }, { once: true });
    });
    return connection;
  }

  private fail(error: Error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }

  async request(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<any> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new NativeConnectionUnavailable("UpNote CDP is not connected.");
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new NativeConnectionUnavailable(`CDP ${method} timed out. Inspect state before retrying any edit.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string, timeoutMs?: number): Promise<T> {
    const result = await this.request("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (result.exceptionDetails) throw new Error(`UpNote runtime: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result?.value as T;
  }

  close() { this.fail(new Error("UpNote CDP connection disposed.")); this.socket.close(); }
}

/** Read-only capability inventory; never returns auth data or note contents. */
export const inspectNativeRuntime = `(() => {
  const root = document.querySelector('#app')?.__vue_app__ || document.querySelector('[data-v-app]')?.__vue_app__;
  const pinia = root?.config?.globalProperties?.$pinia;
  return {
    location: location.href,
    databasePath: window.upnote?.sqlPreload?.getLocation?.(),
    rootFound: !!root, piniaFound: !!pinia,
    appVersion: pinia?._s.get('staticStore')?.appVersion,
    coreMethods: pinia ? Object.keys(pinia._s.get('coreStore') || {}).filter(k => /updateNotes|setNavigationState|currentNoteContent|isCurrentNoteModified/.test(k)) : [],
  };
})()`;

export type NativePayload = {
  action: "status" | "check" | "apply" | "verify";
  databasePath: string;
  expected?: Record<string, unknown>;
  patch?: Record<string, string | number>;
};

/** Only fixed app actions are exposed by MCP, never arbitrary JS or SQL. */
export function nativeExpression(payload: NativePayload): string {
  return `(${nativeRuntime.toString()})(${JSON.stringify(payload)},${assertNativeNoteData.toString()})`;
}

// Runs inside UpNote's renderer. Do not access credentials, change lock state,
// patch bundled app code, or manually set revision/sync flags here.
async function nativeRuntime(input: NativePayload, validateNote: typeof assertNativeNoteData) {
  const w = globalThis as any;
  const root = w.document.querySelector("#app")?.__vue_app__;
  const pinia = root?.config?.globalProperties?.$pinia;
  const incompatible = (detail: string): never => { throw new Error(`Incompatible UpNote internal API: ${detail}`); };
  if (typeof pinia?._s?.get !== "function") incompatible("missing Pinia store lookup.");
  const store = pinia._s.get("coreStore");
  const ui = pinia._s.get("uiStore");
  const lock = pinia._s.get("lockStore");
  const version = pinia._s.get("staticStore")?.appVersion;
  const sql = w.upnote?.sqlPreload;
  const methods = [[store, "updateNotes", "coreStore"], [store, "setNavigationState", "coreStore"], [ui, "setSelectedNoteId", "uiStore"], [sql, "get", "sqlPreload"], [sql, "getLocation", "sqlPreload"]] as const;
  for (const [owner, method, label] of methods) if (typeof owner?.[method] !== "function") incompatible(`missing ${label}.${method}().`);
  for (const field of ["localDataLoaded", "isCurrentNoteModified", "currentWorkspaceLocked"]) if (typeof store[field] !== "boolean") incompatible(`coreStore.${field} must be a boolean.`);
  for (const field of ["shouldShowAppLock", "shouldShowPartialLock"]) if (typeof lock?.[field] !== "boolean") incompatible(`lockStore.${field} must be a boolean.`);
  if (typeof store.notes?.get !== "function") incompatible("coreStore.notes must support get(id).");
  if (!store.current || typeof store.current !== "object" || Array.isArray(store.current) || typeof store.current.mode !== "string" || !("noteId" in store.current) || (store.current.noteId !== null && typeof store.current.noteId !== "string")) incompatible("unsupported coreStore.current navigation state.");
  for (const field of ["currentNoteId", "spaceId"]) if (!(field in store) || (store[field] !== null && typeof store[field] !== "string")) incompatible(`coreStore.${field} must be a string or null.`);
  const readLockedIds = () => {
    const ids = typeof store.getLockedNoteIdsInAllSpaces === "function" ? store.getLockedNoteIdsInAllSpaces() : store.getLockedNoteIdsInAllSpaces;
    if (!(ids instanceof Set) || [...ids].some(id => typeof id !== "string")) incompatible("locked-note lookup must return a Set of note IDs.");
    return ids;
  };
  const lockedIds = readLockedIds();
  const normalizePath = (value: string) => value.replace(/\\/g, "/").toLowerCase();
  const databasePath = sql.getLocation();
  if (typeof databasePath !== "string" || !databasePath) incompatible("sqlPreload.getLocation() must return a path string.");
  if (normalizePath(databasePath) !== normalizePath(input.databasePath)) throw new Error("CDP is connected to a different UpNote database/profile.");
  if (lock.shouldShowAppLock || lock.shouldShowPartialLock || store.currentWorkspaceLocked) throw new Error("Unlock UpNote in the app before native editing.");
  if (!store.localDataLoaded) throw new Error("Wait for UpNote to finish loading its data.");
  const compatibility = { compatible: true, check: "methods-state-types", checkedMethods: methods.map(([, name, label]) => `${label}.${name}`), versionPolicy: "informational-only", noteDataChecked: false };
  const base = { appVersion: typeof version === "string" ? version : null, databasePath, currentNoteId: store.currentNoteId, unsavedEditorChanges: store.isCurrentNoteModified, compatibility };
  if (input.action === "status") return base;
  const expected = input.expected;
  if (!expected || typeof expected.id !== "string") throw new Error("Missing expected note snapshot.");
  validateNote(expected, "sqlite");
  const id = expected.id;
  if (lockedIds.has(id)) throw new Error("The target note is locked.");
  const actual = sql.get("notes", id);
  if (actual) validateNote(actual, "app");
  if (!actual || actual.deleted || actual.trashed || actual.createdAt !== expected.createdAt) throw new Error("Active target note not found or identity changed.");
  compatibility.noteDataChecked = true;
  const normalizeSpace = (value: unknown) => value == null || value === "default" ? "" : String(value);
  if (normalizeSpace(actual.space) !== normalizeSpace(store.spaceId)) throw new Error("Select the target note's workspace in UpNote before native editing.");
  const cleanText = (value: unknown) => String(value ?? "").replace(/\s+/gu, "").trim();
  if (input.action === "verify") {
    const editors = [...w.document.querySelectorAll(".shine-editor")].filter((element: any) => element.isConnected);
    return { ...base, editorMatches: store.currentNoteId === id && editors.some((element: any) => cleanText(element.textContent) === cleanText(input.patch?.text ?? expected.text)) };
  }
  const checkWriteState = () => {
    if (lock.shouldShowAppLock || lock.shouldShowPartialLock || store.currentWorkspaceLocked || readLockedIds().has(id)) throw new Error("Unlock UpNote in the app before native editing.");
    if (store.isCurrentNoteModified) throw new Error("UpNote has unsaved editor changes. Save them before native editing.");
    const current = sql.get("notes", id);
    validateNote(current, "app");
    if (current.deleted || current.trashed) throw new Error("The target note is no longer active.");
    if (normalizeSpace(current.space) !== normalizeSpace(store.spaceId)) throw new Error("The target note's workspace changed before native editing.");
    for (const field of ["id", "title", "html", "text", "createdAt", "updatedAt", "revision"]) {
      if (current[field] !== expected[field]) throw new Error(`The note changed before native editing (${field}). Read get_note again.`);
    }
    if (!!current.synced !== !!expected.synced) throw new Error("The note's sync state changed. Read get_note again.");
    const metadata = store.notes.get(id);
    if (!metadata || ["title", "revision", "updatedAt"].some(field => metadata[field] !== expected[field])) throw new Error("UpNote's in-memory note is stale. Reload the app normally before native editing.");
  };
  checkWriteState();
  if (input.action === "check") return base;
  if (input.action !== "apply" || !input.patch) throw new Error("Unsupported native action.");
  const allowed = new Set(["title", "html", "text", "summary", "hasTodo"]);
  if (Object.keys(input.patch).some(key => !allowed.has(key))) throw new Error("Unsupported native edit field.");
  await store.setNavigationState({ ...store.current, mode: "notes-all", noteId: id, notebookId: "", filterId: "", tagId: "" });
  await ui.setSelectedNoteId(id);
  if (store.currentNoteId !== id) incompatible("navigation did not select the requested note.");
  checkWriteState();
  await store.updateNotes([{ ...input.patch, id, updatedAt: Math.max(Date.now(), Number(actual.updatedAt) + 1) }]);
  return { ...base, accepted: true, id };
}
