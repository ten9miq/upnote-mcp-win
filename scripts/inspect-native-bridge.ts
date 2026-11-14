import { NativeConnection, inspectNativeRuntime } from "../src/native-bridge";
const connection = await NativeConnection.connect(process.argv[2] ?? "http://127.0.0.1:19330");
try { console.log(JSON.stringify(await connection.evaluate(inspectNativeRuntime), null, 2)); }
finally { connection.close(); }
