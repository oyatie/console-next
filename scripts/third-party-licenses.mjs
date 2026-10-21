// SPDX-License-Identifier: LicenseRef-Proprietary
// Third-party licences (public-readiness L-6, L-7).
//   node scripts/third-party-licenses.mjs --check                 npm licence gate: every production package in
//                                                                  package-lock.json has an allowed licence
//   node scripts/third-party-licenses.mjs [--out FILE]            THIRD_PARTY_LICENSES for the web bundle
//   node scripts/third-party-licenses.mjs --cargo MANIFEST [--out FILE]   the same for a Rust build (backend
//                                                                  image, desktop installer), from cargo metadata
// Release-time output, not committed (a committed copy drifts with every lockfile change). Rust licence gates are
// cargo-deny (backend/deny.toml, apps/desktop/src-tauri/deny.toml); this file only renders their texts.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Mirrors backend/deny.toml [licenses].allow, plus OFL-1.1 (Pretendard) and Unlicense (isbot; public-domain
// dedication, on the appendix §6 accepted list).
export const ALLOW = new Set(["MIT", "0BSD", "Apache-2.0", "Apache-2.0 WITH LLVM-exception", "BSD-2-Clause",
  "BSD-3-Clause", "ISC", "Zlib", "MPL-2.0", "Unicode-3.0", "CC0-1.0", "BSL-1.0", "CDLA-Permissive-2.0", "OFL-1.1", "Unlicense"]);

/** Whether an SPDX expression is satisfied by the allow list (OR: any branch, AND: every part). */
export function allowed(expr) {
  const e = expr.trim().replace(/^\((.*)\)$/s, "$1").trim();
  const split = (op) => {
    let depth = 0, last = 0; const parts = [];
    for (let i = 0; i < e.length; i++) {
      if (e[i] === "(") depth++;
      else if (e[i] === ")") depth--;
      else if (depth === 0 && e.startsWith(op, i)) { parts.push(e.slice(last, i)); last = i + op.length; }
    }
    return parts.length ? [...parts, e.slice(last)] : null;
  };
  const or = split(" OR ");
  if (or) return or.some(allowed);
  const and = split(" AND ");
  if (and) return and.every(allowed);
  return ALLOW.has(e);
}

/** Production packages from a package-lock.json object: [{ name, version, license, dir }]. */
export function npmProd(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([p, m]) => p.startsWith("node_modules/") && !m.dev && !m.link)
    .map(([p, m]) => ({ name: p.split("node_modules/").at(-1), version: m.version, license: m.license ?? "NONE", dir: p }));
}

// every resolved non-workspace package, dev and build dependencies included (over-attribution is
// harmless); walk the resolve graph by dep kind and target if the list must match one binary exactly.
function cargoDeps(manifest) {
  const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--manifest-path", manifest],
    { encoding: "utf8", maxBuffer: 1 << 28 }));
  const members = new Set(meta.workspace_members);
  return meta.packages.filter((p) => !members.has(p.id) && p.source)
    .map((p) => ({ name: p.name, version: p.version, license: p.license ?? (p.license_file ? `file:${p.license_file}` : "NONE"),
      dir: path.dirname(p.manifest_path) }));
}

// Licence files at the package root; a LICENSES/ directory (REUSE layout) contributes each file in it.
const texts = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [])
  .filter((e) => /^(licen[cs]e|copying|notice|ofl)/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((e) => (e.isDirectory() ? readdirSync(path.join(dir, e.name)).sort().map((f) => path.join(e.name, f)) : [e.name]))
  .map((f) => `--- ${f}\n${readFileSync(path.join(dir, f), "utf8").trim()}`);

export function render(deps) {
  const head = "Third-party software in this artifact, with each licence as its package ships it.\n";
  return head + deps.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .map((d) => {
      const found = texts(d.dir);
      return [`\n=== ${d.name} ${d.version} (${d.license})`,
        ...(found.length ? found : [`--- no licence file in the package; see the SPDX text of ${d.license}`])].join("\n");
    })
    .join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const cargo = arg("--cargo");
  const deps = cargo ? cargoDeps(cargo) : npmProd(JSON.parse(readFileSync("package-lock.json", "utf8")));
  if (process.argv.includes("--check")) {
    const bad = deps.filter((d) => !allowed(d.license));
    for (const d of bad) console.error(`${d.name}@${d.version}: licence "${d.license}" is not in the allow list`);
    console.log(`licences: ${deps.length} production package(s), ${bad.length} not allowed`);
    process.exit(bad.length ? 1 : 0);
  }
  const out = render(deps);
  if (arg("--out")) writeFileSync(arg("--out"), out); else process.stdout.write(out);
}
