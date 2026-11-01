// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inventory, rustInventory } from "./access-inventory.mjs";
import { collectAccessFunctions, resolveHandler, scanRustSyntax } from "./check-request-body-contract.mjs";

export function actionRegistry(read) {
  const registry = scanRustSyntax(read("cedar_pbac/actions/mod.rs"), { projectCode: true });
  const table = registry.projection?.match(/\bACTION_SCHEMAS\s*:\s*&\s*\[ActionSchema\]\s*=\s*&\s*\[([\s\S]*?)\];/);
  if (!registry.valid || !table) throw new Error("Cedar action registry unresolved");
  const modules = [...table[1].matchAll(/\b(\w+)::SCHEMA\b/g)].map(m => m[1]);
  const enrolled = new Set(modules.map(name => scanRustSyntax(read(`cedar_pbac/actions/${name}.rs`), { projectCode: true })
    .projection?.match(/\bfeature:\s*Feature::(\w+)/)?.[1]));
  return read("feature/names.rs").split("\n").filter(line => enrolled.has(line.match(/Self::(\w+)\s*=>/)?.[1])).join("\n");
}

export function censusRows(rest, names, functions) {
  const registry = new Map([...names.matchAll(/Self::(\w+)\s*=>\s*"([^"]+)"/g)].map(m => [m[1], m[2]]));
  return rest.filter(r => /^(POST|PUT|PATCH|DELETE)$/.test(r.method)).map(r => {
    const actions = new Set(), models = new Set(r.models), seen = new Set();
    const visit = fn => {
      if (!fn || seen.has(fn)) return;
      seen.add(fn);
      const localModels = rustInventory(fn.file, `fn evidence() ${fn.body}`).functions[0]?.models ?? [];
      if (/\b(?:compile_action_bundle|evaluate_with_facts)\s*\(/.test(fn.code)) localModels.push("Cedar");
      for (const model of localModels) models.add(model);
      if (localModels.includes("Cedar")) {
        for (const m of fn.code.matchAll(/\bFeature::(\w+)\b/g)) if (registry.has(m[1])) actions.add(registry.get(m[1]));
      }
      // Static, unambiguous free-function calls only; trait dispatch remains unresolved.
      for (const call of fn.code.matchAll(/(?<![.\w])((?:\w+::)*\w+)\s*\(/g)) visit(resolveHandler(functions, { ...fn, handler: call[1] }));
    };
    const candidates = functions.filter(f => f.file === r.handlerFile && f.name === r.handler?.split("::").at(-1));
    if (candidates.length === 1) visit(candidates[0]);
    return { operation: `${r.method} ${r.path}`, models: [...models].sort(), cedar_actions: [...actions].sort() };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  console.log(JSON.stringify(censusRows(inventory(root).rest,
    actionRegistry(file => readFileSync(path.join(root, "backend/crates/platform/authz/src", file), "utf8")),
    collectAccessFunctions(root)), null, 2));
}
