import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("large-note MCP context, size rejection and partial preview work in an isolated protocol process", () => {
  // Isolate the large WebSocket fixture from Bun 1.4.0's shared VM/HTTP test state.
  const child = Bun.spawnSync([process.execPath, "run", resolve(import.meta.dir, "../scripts/test-large-partial-protocol.ts")], {
    stdout: "pipe", stderr: "pipe", timeout: 25_000,
  });
  const stdout = child.stdout.toString(); const stderr = child.stderr.toString(); const code = child.exitCode;
  expect(code === 0 ? "ok" : stderr).toBe("ok");
  const result = JSON.parse(stdout.trim());
  expect(result.oversizedRejected).toBe(true);
  expect(result.contextChars).toBeLessThan(5000);
  expect(result.previewChars).toBeLessThan(10_000);
  expect(result.noteUnchanged).toBe(true);
}, 30_000);
