import { expect, test } from "bun:test";
import { connectWithRecovery } from "./connection";
import { NativeConnectionUnavailable, type NativeChannel } from "./native-bridge";

function channels() {
  const all: Array<NativeChannel & { closed: boolean }> = [];
  const make = () => {
    const channel = { closed: false, async evaluate<T>() { return {} as T; }, close() { this.closed = true; } };
    all.push(channel); return channel;
  };
  return { all, make };
}
const origin = "http://127.0.0.1:19330";

test("a ready app is reused without launching or closing the returned connection", async () => {
  const c = channels(); let launches = 0;
  const result = await connectWithRecovery({ endpoint: origin, key: "ready", autoStart: true,
    connect: async () => c.make(), ready: async () => {}, launch: async () => { launches++; } });
  expect(launches).toBe(0); expect(c.all[0]?.closed).toBe(false); result.close();
});

test("a closed app starts once, waits for its data, and disposes readiness probes", async () => {
  const c = channels(); let running = false; let launches = 0; let checks = 0;
  const result = await connectWithRecovery({ endpoint: origin, key: "cold", autoStart: true,
    connect: async () => { if (!running) throw new NativeConnectionUnavailable("closed"); return c.make(); },
    ready: async () => { if (++checks < 3) throw new Error("Wait for UpNote to finish loading its data."); },
    launch: async () => { launches++; running = true; }, pollMs: 1, timeoutMs: 200 });
  expect(launches).toBe(1); expect(checks).toBeGreaterThanOrEqual(3);
  expect(c.all.filter(item => !item.closed).map(item => item === result)).toEqual([true]); result.close();
});

test("parallel connection requests share a single app startup", async () => {
  const c = channels(); let running = false; let launches = 0;
  const options = { endpoint: origin, key: "parallel", autoStart: true,
    connect: async () => { if (!running) throw new NativeConnectionUnavailable("closed"); return c.make(); },
    ready: async () => {}, launch: async () => { launches++; await Bun.sleep(10); running = true; } };
  const connections = await Promise.all(Array.from({ length: 5 }, () => connectWithRecovery(options)));
  expect(launches).toBe(1); expect(new Set(connections).size).toBe(5);
  for (const connection of connections) connection.close();
  expect(c.all.every(item => item.closed)).toBe(true);
});

test("initializing existing apps are waited for without starting a second instance", async () => {
  const c = channels(); let checks = 0; let launches = 0;
  const result = await connectWithRecovery({ endpoint: origin, key: "initializing", autoStart: true,
    connect: async () => c.make(), ready: async () => { if (++checks < 3) throw new Error("Incompatible UpNote internal API: missing Pinia store lookup."); },
    launch: async () => { launches++; }, pollMs: 1, timeoutMs: 200 });
  expect(launches).toBe(0); result.close(); expect(c.all.every(item => item.closed)).toBe(true);
});

test("incompatibility or locked-app errors never cause a restart or a retry", async () => {
  for (const reason of ["different database/profile", "Unlock UpNote", "missing coreStore.updateNotes()"] ) {
    const c = channels(); let launches = 0; let checks = 0;
    await expect(connectWithRecovery({ endpoint: origin, key: reason, autoStart: true,
      connect: async () => c.make(), ready: async () => { checks++; throw new Error(reason); }, launch: async () => { launches++; } })).rejects.toThrow(reason);
    expect(launches).toBe(0); expect(checks).toBe(1); expect(c.all.every(item => item.closed)).toBe(true);
  }
});

test("disabled auto-start and invalid endpoints cannot launch an app", async () => {
  let launches = 0;
  const options = { endpoint: origin, key: "disabled", autoStart: false,
    connect: async (): Promise<NativeChannel> => { throw new NativeConnectionUnavailable("closed"); }, ready: async () => {}, launch: async () => { launches++; } };
  await expect(connectWithRecovery(options)).rejects.toThrow("closed");
  await expect(connectWithRecovery({ ...options, autoStart: true, endpoint: "http://example.com" })).rejects.toThrow("loopback");
  expect(launches).toBe(0);
});

test("a failed launch is not repeated and a cold app has bounded readiness waits", async () => {
  let launches = 0;
  const options = { endpoint: origin, key: "failed-launch", autoStart: true,
    connect: async (): Promise<NativeChannel> => { throw new NativeConnectionUnavailable("renderer not ready"); }, ready: async () => {},
    launch: async () => { launches++; throw new Error("already running without CDP"); }, pollMs: 1, timeoutMs: 10 };
  await expect(connectWithRecovery(options)).rejects.toThrow("already running without CDP");
  expect(launches).toBe(1);
  await expect(connectWithRecovery({ ...options, key: "bounded", launch: async () => { launches++; } })).rejects.toThrow("did not become ready");
  expect(launches).toBe(2);
});

test("a later app exit can be recovered again without retaining a stale startup flight", async () => {
  const c = channels(); let running = false; let launches = 0;
  const options = { endpoint: origin, key: "subsequent-exit", autoStart: true,
    connect: async () => { if (!running) throw new NativeConnectionUnavailable("closed"); return c.make(); },
    ready: async () => {}, launch: async () => { launches++; running = true; } };
  (await connectWithRecovery(options)).close();
  running = false;
  (await connectWithRecovery(options)).close();
  expect(launches).toBe(2); expect(c.all.every(item => item.closed)).toBe(true);
});
