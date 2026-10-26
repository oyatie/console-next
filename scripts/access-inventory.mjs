#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import yaml from "js-yaml";
import { collectAccessRoutes, scanRustSyntax } from "./check-request-body-contract.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT = "docs/authz/access-inventory";
const MODELS = [
  ["matrix", /(?<![.\w])(?:authorize(?:_org_wide|_scoped|_capability\w*)?|Action::new)\s*\(/g],
  ["BranchScope", /\bBranchScope\b|\.branch_scope\b/g],
  ["ScopeGrant", /\bScopeGrant\b|\.(?:scope_grants|grants_for)\b/g],
  ["Cedar", /\b(?:AccessSlice|DecisionFacts|load_facts|enforce_action|ActionBundle)\b|\b\w+::decide\s*\(/g],
  ["RLS", /\b(?:with_org_conn|with_org_tx|RlsScopeProof|set_config)\b/g],
];
const lineAt = (s, at) => s.slice(0, at).split("\n").length;
const order = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en");

function files(root, dir, extension) {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const file = `${dir}/${e.name}`;
    if (e.isDirectory()) return /^(tests|fixtures|target|node_modules|\.)/.test(e.name) ? [] : files(root, file, extension);
    return extension.test(e.name) && !/(?:_tests|\.test|\.spec)\./.test(e.name) ? [file] : [];
  }).sort();
}

export function rustInventory(file, source) {
  // Inline test modules are not serving surfaces.
  source = source.split(/#\[cfg\(test\)\]\s*(?:mod\s+tests|#\[path)/)[0];
  const scanned = scanRustSyntax(source, { projectCode: true });
  if (!scanned.valid) throw new Error(`${file}: ${scanned.error}`);
  const code = scanned.projection;
  const references = MODELS.flatMap(([model, pattern]) => [...code.matchAll(pattern)].map((m) => ({
    file, line: lineAt(source, m.index), model, expression: source.slice(m.index, m.index + m[0].length).trim(),
  })));
  const functions = [];
  const findings = [];
  for (const m of code.matchAll(/\bfn\s+(\w+)\s*(?:<[^;{]*>)?\s*\(/g)) {
    const opening = code.indexOf("{", m.index);
    const semi = code.indexOf(";", m.index);
    if (opening < 0 || (semi >= 0 && semi < opening)) continue;
    const body = scanRustSyntax(source, { start: opening, rootDelimiter: "{" });
    if (!body.valid) throw new Error(`${file}::${m[1]}: ${body.error}`);
    const text = code.slice(opening, body.closing + 1);
    const line = lineAt(source, m.index);
    const end = lineAt(source, body.closing);
    const models = [...new Set(references.filter((r) => r.line >= line && r.line <= end).map((r) => r.model))];
    functions.push({ file, line, name: m[1], models });
    if (/\bbranch_id\.is_some\(\)\s*\|\|/.test(text) && /BranchScope::All/.test(text)) {
      findings.push({ file, line, kind: "branch-required-for-scoped-holder", surface: m[1] });
    }
    const filters = [...text.matchAll(/\.filter\(\|[^|]*\|\s*\{([\s\S]*?)\}\)/g)].map((x) => x[1]).join("\n");
    if (/q\.unit_id/.test(text) && /q\.workplace_id/.test(filters) && !/q\.unit_id/.test(filters)) {
      findings.push({ file, line, kind: "department-selector-missing-from-row-filter", surface: m[1] });
    }
    for (const facts of text.matchAll(/\b\w*Facts\s*\{([^{}]*)\}/g)) {
      const values = [...facts[1].matchAll(/\b\w+\s*:\s*(true|false)\b/g)];
      if (values.length && values.every((v) => v[1] === "true")) {
        findings.push({ file, line: lineAt(source, opening + facts.index), kind: "all-boolean-facts-hardcoded-true", surface: m[1] });
      }
    }
  }
  return { references, functions, findings };
}

export function webInventory(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const surfaces = [];
  const grantNames = new Set(["useCan", "granted"]);
  const grantReaders = new Set();
  const visitImports = (node) => {
    if (ts.isImportSpecifier(node) && grantNames.has(node.propertyName?.text ?? node.name.text)) grantNames.add(node.name.text);
    ts.forEachChild(node, visitImports);
  };
  visitImports(ast);
  const readers = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && ts.isCallExpression(node.initializer) && grantNames.has(node.initializer.expression.getText(ast))) {
      grantReaders.add(node.name.text);
    }
    ts.forEachChild(node, readers);
  };
  readers(ast);
  const add = (node, kind, name, model) => surfaces.push({ file, line: lineAt(source, node.getStart(ast)), kind, name, model });
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && grantNames.has(node.expression.text)) {
      add(node, "control-guard", node.getText(ast), "web-grants");
    }
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(ast);
      if (grantReaders.has(name) || /(?:^|\.)can$/.test(name) || /^(?:useCan|granted)\(/.test(name)) {
        add(node, "control-guard", node.getText(ast), grantReaders.has(name) || /^(?:useCan|granted)\(/.test(name) ? "web-grants" : "control-call-unmapped");
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const key = node.name.getText(ast).replace(/["']/g, "");
      if (key === "anyOf") add(node, "grant-guard", node.initializer.getText(ast), "web-grants");
      if (key === "to" && ts.isStringLiteral(node.initializer) && file.includes("/shell/")) {
        add(node, "nav", node.initializer.text, "server-read-unmapped");
      }
      if (key === "path" && file.includes("/routes/")) {
        const object = node.parent;
        const guard = object.properties?.find((p) => p.name?.getText(ast) === "beforeLoad");
        add(node, "route", node.initializer.getText(ast), guard ? "route-hook-unmapped" : "server-read-unmapped");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return surfaces;
}

export function inventory(root) {
  const rust = [...files(root, "backend/app/src", /\.rs$/), ...files(root, "backend/crates", /\.rs$/)]
    .map((file) => rustInventory(file, readFileSync(path.join(root, file), "utf8")));
  const references = rust.flatMap((r) => r.references).sort(order);
  const functions = rust.flatMap((r) => r.functions);
  const routes = collectAccessRoutes(root);
  const endpoint = (route) => {
    const handler = functions.find((f) => f.file === route.handlerFile && f.name === route.handlerName);
    return {
      file: route.file, method: route.method.toUpperCase(), path: route.path,
      handler: route.handler, handlerFile: route.handlerFile, line: handler?.line ?? null,
      models: handler?.models ?? [],
      // File references are leads for a reviewer, never proof a handler enforces them.
      fileModels: [...new Set(references.filter((r) => r.file === route.handlerFile).map((r) => r.model))].sort(),
      resolution: handler?.models.length ? "direct-evidence-only" : "access-unresolved",
    };
  };
  const rest = [...new Map(routes.map(endpoint).map((r) => [JSON.stringify(r), r])).values()];
  const spec = yaml.load(readFileSync(path.join(root, "backend/openapi/openapi.yaml"), "utf8"));
  for (const [url, item] of Object.entries(spec.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete", "head", "options"]) {
      if (item[method] && !rest.some((r) => r.path === url && r.method === method.toUpperCase())) {
        rest.push({ file: "backend/openapi/openapi.yaml", path: url, method: method.toUpperCase(),
          handler: item[method].operationId ?? null, models: [], resolution: "route-unresolved" });
      }
    }
  }
  return {
    version: 1,
    coverage: "All REST methods (superset of reads); named read functions; routes, nav and grant guards. Static evidence only; unresolved is never Cedar coverage.",
    rest: rest.sort(order),
    reads: functions.filter((f) => /(?:list|count|search|export|inbox|board|roster|badge|queue|tree)/i.test(f.name)).sort(order),
    web: files(root, "apps/web/src", /\.tsx?$/).flatMap((file) => webInventory(file, readFileSync(path.join(root, file), "utf8"))).sort(order),
    references,
    findings: rust.flatMap((r) => r.findings).sort(order),
  };
}

// Only retiring models and detected defects ratchet; Cedar/RLS growth is expected.
export function ratchet(data) {
  const counts = new Map();
  const add = (model, file, kind) => {
    const key = JSON.stringify([model, file, kind]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const r of data.references) {
    if (["matrix", "BranchScope", "ScopeGrant"].includes(r.model)) add(r.model, r.file, "reference");
  }
  for (const r of data.web) {
    if (r.model === "web-grants") add(r.model, r.file, r.kind);
  }
  for (const r of data.findings) add("finding", r.file, r.kind);
  return { version: 2, limits: [...counts].map(([key, count]) => {
    const [model, file, kind] = JSON.parse(key);
    return { model, file, kind, count };
  }).sort(order) };
}

export function checkRatchet(current, baseline) {
  const key = (r) => JSON.stringify([r.model, r.file, r.kind]);
  const allowed = new Map(baseline.limits.map((r) => [key(r), r.count]));
  const violations = current.limits.filter((r) => r.count > (allowed.get(key(r)) ?? 0));
  if (violations.length) throw new Error(`Access ratchet increased: ${JSON.stringify(violations)}`);
}

export function markdown(data) {
  return `<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Access inventory ratchet

Gate: \`node scripts/access-inventory.mjs\`. Shrink the budget after removals: \`node scripts/access-inventory.mjs --write\`.
The generated [budget](access-inventory.json) is keyed by model, file and finding kind, with counts per key.
Line shifts and removals pass; any new key or count increase fails, including when writing the budget.
Cedar and RLS references may grow as legacy access decisions migrate.

The scanner still discovers every REST operation, named list/count/search/export/inbox read, web route/nav/control and access reference.
Detailed census (including current line numbers) is available on demand, without a committed snapshot:
\`node scripts/access-inventory.mjs --census > /tmp/access-census.json\`.
Static references are reviewer leads, never proof of enforcement or route/first-read parity.
Detector fixtures retain historical defects after the product fixes them.

| Model | File | Kind | Maximum count |
| --- | --- | --- | --- |
${data.limits.map((r) => `| ${r.model} | ${r.file} | ${r.kind} | ${r.count} |`).join("\n")}
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = inventory(ROOT);
  if (process.argv.includes("--census")) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const current = ratchet(data);
    const baseline = JSON.parse(readFileSync(path.join(ROOT, `${OUTPUT}.json`), "utf8"));
    checkRatchet(current, baseline);
    if (process.argv.includes("--write")) {
      writeFileSync(path.join(ROOT, `${OUTPUT}.json`), `${JSON.stringify(current, null, 2)}\n`);
      writeFileSync(path.join(ROOT, `${OUTPUT}.md`), markdown(current));
    }
    console.log(`access-inventory: ${data.rest.length} REST, ${data.reads.length} reads, ${data.web.length} web, ${data.references.length} model references, ${data.findings.length} findings; ratchet passed`);
  }
}
