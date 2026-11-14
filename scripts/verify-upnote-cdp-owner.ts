import { NativeConnection } from "../src/native-bridge";
const [endpoint, pid] = process.argv.slice(2);
if (!endpoint || !pid) throw new Error("Usage: bun run scripts/verify-upnote-cdp-owner.ts LOOPBACK_CDP_ORIGIN EXPECTED_PID");
await NativeConnection.verifyOwner(endpoint, Number(pid));
console.log(JSON.stringify({ ownerVerified: true, pid: Number(pid), origin: endpoint }));
