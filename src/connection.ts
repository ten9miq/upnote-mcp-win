import { existsSync } from "node:fs";
import { join } from "node:path";
import { loopbackEndpoint, NativeConnectionUnavailable, type NativeChannel } from "./native-bridge";

type RecoveryOptions = {
  endpoint: string;
  key: string;
  autoStart: boolean;
  connect: (endpoint: string) => Promise<NativeChannel>;
  ready: (channel: NativeChannel) => Promise<unknown>;
  launch: (endpoint: string) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
};
const recoveries = new Map<string, Promise<void>>();
const starting = (error: unknown) => error instanceof Error && /Wait for UpNote to finish loading its data|missing Pinia store lookup/.test(error.message);

/** Retry only connection discovery/read-only readiness, never an edit request. */
export async function connectWithRecovery(options: RecoveryOptions): Promise<NativeChannel> {
  loopbackEndpoint(options.endpoint);
  const checked = async () => {
    const channel = await options.connect(options.endpoint);
    try { await options.ready(channel); return channel; }
    catch (error) { channel.close(); throw error; }
  };
  let initialError: unknown;
  try { return await checked(); }
  catch (error) {
    if (!options.autoStart || (!(error instanceof NativeConnectionUnavailable) && !starting(error))) throw error;
    initialError = error;
  }
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const waitReady = async () => {
    do {
      try { return await checked(); }
      catch (error) {
        if (!(error instanceof NativeConnectionUnavailable) && !starting(error)) throw error;
        if (Date.now() >= deadline) throw new NativeConnectionUnavailable(`UpNote did not become ready in time: ${String(error)}`);
        await Bun.sleep(options.pollMs ?? 250);
      }
    } while (true);
  };
  if (starting(initialError)) return waitReady();
  let flight = recoveries.get(options.key);
  if (!flight) {
    flight = (async () => {
      await options.launch(options.endpoint);
      const probe = await waitReady();
      probe.close();
    })().finally(() => { recoveries.delete(options.key); });
    recoveries.set(options.key, flight);
  }
  await flight;
  return waitReady();
}

export async function launchInstalledUpNote(endpoint: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("Automatic UpNote startup currently supports Windows only.");
  const origin = loopbackEndpoint(endpoint);
  if (origin.hostname !== "127.0.0.1" || !origin.port || Number(origin.port) < 1024) throw new Error("Automatic startup requires an IPv4 loopback port of 1024 or higher.");
  const local = process.env.LOCALAPPDATA;
  const path = process.env.UPNOTE_AUTO_START_LAUNCHER ?? (local ? join(local, "UpNoteMcp", "launch.ps1") : "");
  if (!path || !existsSync(path)) throw new Error("The UpNote startup helper is missing. Configure UPNOTE_AUTO_START_LAUNCHER to the installed launch.ps1.");
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = Bun.spawn([powershell, "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-File", path, "-Background", "-Port", origin.port], {
    stdout: "ignore", stderr: "pipe", windowsHide: true, timeout: 25_000,
  });
  const stderr = await new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(`Cannot prepare UpNote automatically: ${stderr.trim() || "the startup helper failed; inspect UpNoteMcp/launch.jsonl"}`);
}
