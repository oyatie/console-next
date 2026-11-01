// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import yaml from "js-yaml";
import { scanRustSyntax } from "./check-request-body-contract.mjs";

function uiTests(source) {
  const ast = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true), tests = [];
  const walk = (node, groups = []) => {
    if (ts.isCallExpression(node)) {
      const call = node.expression.getText(ast), title = node.arguments[0];
      if (call.startsWith("test.describe") && (call !== "test.describe" || !title || !ts.isStringLiteral(title))) return;
      if (/^test(?:\.describe)?$/.test(call) && title && ts.isStringLiteral(title)) {
        if (call === "test.describe") {
          for (const child of node.arguments.slice(1)) walk(child, [...groups, title.text]);
        } else {
          const codes = [];
          const assertions = n => {
            if (ts.isCallExpression(n) && /^expect\([\s\S]*\)\.(?:toBe|toEqual|toStrictEqual|toMatchObject|toContain|toHaveProperty)$/.test(n.expression.getText(ast))) {
              const literals = a => { if (ts.isStringLiteral(a)) codes.push(a.text); ts.forEachChild(a, literals); };
              for (const arg of n.arguments) literals(arg);
            }
            ts.forEachChild(n, assertions);
          };
          for (const child of node.arguments.slice(1)) assertions(child);
          tests.push({ title: [...groups, title.text].join(" › "), codes });
        }
        return;
      }
    }
    ts.forEachChild(node, child => walk(child, groups));
  };
  walk(ast);
  return tests;
}

function rustTests(source, prefix = []) {
  const scanned = scanRustSyntax(source, { projectCode: true });
  if (!scanned.valid) throw new Error(scanned.error);
  const code = scanned.projection, tests = [];
  const modules = [...code.matchAll(/\bmod\s+(\w+)\s*\{/g)].map(m => ({ name: m[1], start: m.index,
    end: scanRustSyntax(source, { start: m.index + m[0].length - 1, rootDelimiter: "{" }).closing }));
  for (const match of code.matchAll(/(?:#\s*\[[^\]]*\]\s*)+(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\([^)]*\)[^{]*\{/g)) {
    if (!/#\s*\[\s*(?:(?:tokio|sqlx)\s*::\s*)?test\b/.test(match[0])) continue;
    const start = match.index + match[0].length - 1;
    const body = scanRustSyntax(source, { start, rootDelimiter: "{" });
    if (!body.valid) throw new Error(body.error);
    const codes = [];
    for (const assertion of code.slice(start, body.closing).matchAll(/\bassert_eq!\s*\(/g)) {
      const opening = start + assertion.index + assertion[0].length - 1;
      const end = scanRustSyntax(source, { start: opening, rootDelimiter: "(" });
      const args = scanRustSyntax(source.slice(opening + 1, end.closing), { splitTopLevel: true });
      for (const arg of args.segments.slice(0, 2)) {
        const literal = arg.match(/^"([a-z][a-z0-9]*(?:_[a-z0-9]+)+)"$/);
        if (literal) codes.push(literal[1]);
      }
    }
    tests.push({ title: [...prefix, ...modules.filter(m => m.start < start && m.end > start).map(m => m.name), match[1]].join("::"), codes });
  }
  return tests;
}

export function buildIndex(contract, sources) {
  const assertions = sources.flatMap(({ file, source, binary, prefix }) => (file.endsWith(".ts") ? uiTests(source) : rustTests(source, prefix))
    .map(test => ({ ...test, file, binary })));
  return Object.entries(contract.paths).flatMap(([route, methods]) => Object.entries(methods).flatMap(([method, op]) => {
    if (!/^(get|post|put|patch|delete|head|options|trace)$/.test(method)) return [];
    const text = [op.summary, op.description, ...Object.values(op.responses ?? {}).map(r => r.description)].join(" ");
    // Same refusal-code grammar as screens/capabilities.py.
    return [...new Set([...text.matchAll(/\b4\d\d\s+`?([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`?/g)].map(m => m[1]))].sort().map(code => {
      const found = assertions.filter(a => a.codes.includes(code));
      return { operation: `${method.toUpperCase()} ${route}`, code,
        ui: found.filter(a => a.file.startsWith("e2e/")).map(({ file, title }) => ({ file, title })),
        be: found.filter(a => a.binary).map(({ file, title, binary }) => ({ file, title, binary })) };
    });
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = execFileSync("git", ["ls-files", "-z", "e2e", "backend"], { encoding: "utf8" }).split("\0")
    .filter(f => /^e2e\/.*\.spec\.ts$/.test(f) || /^backend\/.*(?:\/tests\/.*\.rs|_tests\.rs)$/.test(f));
  const sources = files.map(file => {
    let binary, prefix;
    if (file.endsWith(".rs")) {
      let dir = path.dirname(file);
      while (dir !== "." && !existsSync(path.join(dir, "Cargo.toml"))) dir = path.dirname(dir);
      const pkg = readFileSync(path.join(dir, "Cargo.toml"), "utf8").match(/^name\s*=\s*"([^"]+)"/m)?.[1];
      const integration = file.slice(dir.length + 1).match(/^tests\/([^/.]+)/)?.[1];
      binary = integration ? `${pkg}::${integration}` : pkg;
      // shortcut: conventional Rust module paths only; resolve #[path] overrides before counting custom layouts.
      const parts = file.slice(dir.length + 1).replace(/\.rs$/, "").split("/");
      prefix = parts.slice(integration ? 2 : 1).filter(p => !["mod", "main", "lib"].includes(p));
    }
    return { file, binary, prefix, source: readFileSync(file, "utf8") };
  });
  console.log(JSON.stringify(buildIndex(yaml.load(readFileSync("backend/openapi/openapi.yaml", "utf8")), sources), null, 2));
}
