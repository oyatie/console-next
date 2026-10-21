#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
// Run the gallery proof in Linux Chromium while forwarding its local API origin to the Colima host.
import { spawn } from "node:child_process";
import net from "node:net";

if (process.env.E2E_REUSE !== "1" || process.env.E2E_SERVED === "1") {
  throw new Error("Start a reset E2E backend on the Colima host, then run with E2E_REUSE=1 and E2E_SERVED unset");
}

const port = Number(process.env.CONSOLE_DEV_BACKEND_PORT ?? 8090);
const proxy = net.createServer((client) => {
  const upstream = net.connect(port, "host.lima.internal");
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
});
await new Promise((resolve, reject) => {
  proxy.once("error", reject);
  proxy.listen(port, "127.0.0.1", resolve);
});

const run = spawn("npx", ["playwright", "test", "e2e/visual.spec.ts", ...process.argv.slice(2)], { stdio: "inherit" });
const code = await new Promise((resolve) => run.once("exit", (status) => resolve(status ?? 1)));
proxy.close();
process.exitCode = code;
