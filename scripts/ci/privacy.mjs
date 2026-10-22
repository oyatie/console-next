// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";

const result = spawnSync("python3", [new URL("./scan-uploads.py", import.meta.url).pathname, ...process.argv.slice(2)], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
