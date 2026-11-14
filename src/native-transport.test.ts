import { expect, test } from "bun:test";
import { NativeConnection } from "./native-bridge";

// Keep HTTP/WebSocket fixtures out of node:vm test processes on Bun/Windows.
function cdpServer(options: { foreignSocket?: boolean; popout?: boolean; ownerPid?: number } = {}) {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/json/version") return Response.json({ "User-Agent": "UpNote/9.22.9", webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/browser/test-browser` });
      if (path === "/json/list") return Response.json([
        { id: "main", type: "page", url: "file:///C:/Program%20Files/WindowsApps/24862ThomasDao.UpNote_9.22.9/app/resources/app.asar/dist/electron/index.html", webSocketDebuggerUrl: options.foreignSocket ? "ws://example.com/devtools/page/main" : `ws://127.0.0.1:${server.port}/devtools/page/main` },
        ...(options.popout ? [{ type: "page", url: "file:///C:/UpNote/app/resources/app.asar/dist/electron/index.html?noteWindowId=note-window" }] : []),
      ]);
      if ((path === "/devtools/page/main" || path === "/devtools/browser/test-browser") && server.upgrade(request)) return;
      return new Response("Not found", { status: 404 });
    },
    websocket: { message(socket, input) {
      const request = JSON.parse(String(input));
      if (request.method === "Runtime.evaluate") {
        socket.send(JSON.stringify({ id: request.id, result: { result: { value: request.params.expression } } }));
      } else if (request.method === "SystemInfo.getProcessInfo") {
        socket.send(JSON.stringify({ id: request.id, result: { processInfo: [{ type: "browser", id: options.ownerPid ?? 1234 }] } }));
      }
    } },
  });
  return server;
}

test("CDP transport discovers the verified main target and matches concurrent requests", async () => {
  const server = cdpServer();
  let connection: NativeConnection | undefined;
  try {
    connection = await NativeConnection.connect(`http://127.0.0.1:${server.port}`);
    expect(await Promise.all([connection.evaluate("first"), connection.evaluate("second")])).toEqual(["first", "second"]);
  } finally { connection?.close(); server.stop(true); }
});

test("CDP refuses external WebSocket destinations and pop-out note windows", async () => {
  for (const options of [{ foreignSocket: true }, { popout: true }]) {
    const server = cdpServer(options);
    try { await expect(NativeConnection.connect(`http://127.0.0.1:${server.port}`)).rejects.toThrow(); }
    finally { server.stop(true); }
  }
});

test("launcher ownership verification matches the actual CDP browser PID", async () => {
  const server = cdpServer({ ownerPid: 5678 });
  try {
    await NativeConnection.verifyOwner(`http://127.0.0.1:${server.port}`, 5678);
    await expect(NativeConnection.verifyOwner(`http://127.0.0.1:${server.port}`, 1234)).rejects.toThrow("different browser process");
    await expect(NativeConnection.verifyOwner(`http://127.0.0.1:${server.port}`, -1)).rejects.toThrow("valid UpNote process ID");
  } finally { server.stop(true); }
});
