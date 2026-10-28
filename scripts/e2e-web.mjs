// SPDX-License-Identifier: LicenseRef-Proprietary
import { startBackend } from "./backend-process.mjs";

const web = startBackend("npm run dev", { shell: true, stdio: "inherit" });
web.once("exit", code => process.exit(code ?? 1));
// Playwright owns this pipe: EOF also stops Vite if the runner is killed.
process.stdin.on("end", () => process.exit(1));
process.stdin.resume();
