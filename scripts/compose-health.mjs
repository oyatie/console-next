// SPDX-License-Identifier: LicenseRef-Proprietary
export function startupHealthcheckFiles(engine, compose) {
  const [major, minor, patch] = compose.trim().replace(/^v/, "").split(/[.-]/).map(Number);
  const supported = major > 2 || major === 2 && (minor > 20 || minor === 20 && patch >= 2);
  return Number(engine.split(".")[0]) >= 25 && supported ? ["-f", "deploy/dev/compose.startup.yml"] : [];
}
