#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
// Candidate-bound inventory: a package command alone is not a path from required CI.
// shortcut: traces static Node calls and current CI/Vitest syntax; extend before introducing another runner.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { atBase, qualityRef } from "./quality/ratchet.mjs";

const baselineFile = "scripts/script-reachability-baseline.json";
const candidate = file => /^scripts\/check-[^/]+\.mjs$/.test(file) || file.endsWith(".test.mjs");

function shellCommands(text) {
  const commands = [];
  let command = "", quote = "", escaped = false, comment = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (comment) {
      if (char !== "\n") continue;
      comment = false;
    }
    if (escaped) { command += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { command += char; escaped = true; continue; }
    if (quote) { command += char; if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { command += char; quote = char; continue; }
    if (char === "#" && /(?:^|\s)$/.test(command)) { comment = true; continue; }
    if (char === "\n" || char === ";" || (char === "&" || char === "|") && text[i + 1] === char) {
      commands.push(command.trim());
      command = "";
      if (char === "&" || char === "|") i++;
    } else command += char;
  }
  commands.push(command.trim());
  return commands;
}

// Read run bodies and local reusable workflows, never YAML comments or step names.
function workflowCommands(source) {
  const commands = [];
  const workflows = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const workflow = lines[i].match(/^\s+uses:\s*\.\/(\.github\/workflows\/[^\s]+\.ya?ml)\s*$/);
    if (workflow) workflows.push(workflow[1]);
    const run = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!run) continue;
    if (/^[|>][-+]?\s*$/.test(run[2])) {
      const block = [];
      while (i + 1 < lines.length && (!lines[i + 1].trim() || lines[i + 1].search(/\S/) > run[1].length)) block.push(lines[++i]);
      commands.push(block.join("\n"));
    } else commands.push(run[2].replace(/^(["'])(.*)\1$/, "$2"));
  }
  return { commands, workflows };
}

export function inventory(files, read) {
  files = [...new Set(files)].sort();
  const present = new Set(files);
  const scripts = JSON.parse(read("package.json")).scripts ?? {};
  const callers = new Map();
  const executions = new Map();
  const pending = [];
  const seen = new Set();
  const reach = (file, caller, execute = true) => {
    if (!present.has(file)) throw new Error(`${caller}: missing input ${file}`);
    if (!callers.has(file)) { callers.set(file, new Set()); pending.push(file); }
    callers.get(file).add(caller);
    if (execute) {
      if (!executions.has(file)) executions.set(file, new Set());
      executions.get(file).add(caller);
    }
  };
  const command = (text, caller) => {
    for (const invocation of shellCommands(text)) {
      const parsed = invocation.match(/^(?:[A-Z_][A-Z_\d]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*(?:npx\s+)?(npm|node|vitest)\s+([\s\S]*)$/);
      if (!parsed) continue;
      const [, bin, args] = parsed;
      if (bin === "npm") {
        const invoked = args.match(/^(?:(run)\s+)?([\w:-]+)/);
        if (!invoked) continue;
        const [, run, name] = invoked;
        if (!run && !["test", "start"].includes(name)) continue;
        if (!(name in scripts)) throw new Error(`${caller}: missing npm script: ${name}`);
        if (seen.has(`npm:${name}`)) continue;
        seen.add(`npm:${name}`);
        command(scripts[name], `package.json#${name}`);
      }
      if (bin === "node") for (const token of args.split(/\s+/)) {
        if (token === "#" || ["-e", "--eval", "-p", "--print"].includes(token)) break;
        const pattern = token.replace(/^["']|["']$/g, "");
        if (!pattern.endsWith(".mjs")) continue;
        const matched = files.filter(file => path.matchesGlob(file, pattern));
        if (!matched.length) throw new Error(`${caller}: unmatched Node input ${pattern}`);
        for (const file of matched) reach(file, caller);
      }
      if (bin !== "vitest" || !/^run\b/.test(args)) continue;
      const config = ts.createSourceFile("vitest.config.ts", read("vitest.config.ts"), ts.ScriptTarget.Latest, true);
      const visit = node => {
        if (ts.isPropertyAssignment(node) && node.name.getText(config) === "include" && ts.isArrayLiteralExpression(node.initializer)) {
          for (const glob of node.initializer.elements.filter(ts.isStringLiteral)) {
            for (const entry of files.filter(file => file.startsWith("scripts/") && path.matchesGlob(file, glob.text))) reach(entry, "vitest.config.ts#include");
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(config);
    }
  };
  reach(".github/workflows/ci.yml", "required CI");
  for (let i = 0; i < pending.length; i++) {
    const file = pending[i];
    const source = read(file);
    if (file.endsWith(".yml") || file.endsWith(".yaml")) {
      const workflow = workflowCommands(source);
      for (const child of workflow.workflows) reach(child, file);
      for (const text of workflow.commands) command(text, file);
      continue;
    }
    if (!file.startsWith("scripts/")) continue;
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const constants = new Map();
    const value = node => {
      if (!node) return undefined;
      if (ts.isStringLiteral(node)) return node.text;
      if (ts.isIdentifier(node)) return constants.get(node.text);
      if (node.getText(ast) === "import.meta.dirname") return path.posix.dirname(file);
      if (ts.isArrayLiteralExpression(node)) return node.elements.map(value);
      if (ts.isNewExpression(node) && node.expression.getText(ast) === "URL") {
        const spec = value(node.arguments?.[0]);
        if (typeof spec === "string" && spec.startsWith(".")) return path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      }
      if (ts.isCallExpression(node) && /(?:^|\.)(?:fileURLToPath|resolve|join)$/.test(node.expression.getText(ast))) {
        const parts = node.arguments.map(value);
        if (parts.length && parts.every(part => typeof part === "string")) return path.posix.join(...parts);
      }
      return undefined;
    };
    const visit = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) constants.set(node.name.text, value(node.initializer));
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const spec = node.moduleSpecifier;
        if (spec && ts.isStringLiteral(spec) && spec.text.startsWith(".")) {
          const local = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec.text));
          if (present.has(local) && /\.(?:mjs|ts)$/.test(local)) reach(local, file, false);
        }
      }
      if (ts.isCallExpression(node) && /^(?:run|spawnSync|execFileSync)$/.test(node.expression.getText(ast))) {
        const bin = value(node.arguments[0]);
        const args = value(node.arguments[1]);
        if ((bin === "node" || node.arguments[0]?.getText(ast) === "process.execPath") && Array.isArray(args)) {
          for (const input of args.filter(arg => typeof arg === "string" && arg.endsWith(".mjs"))) reach(input, file);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return files.filter(candidate).map(file => ({
    file,
    // Importing a guarded CLI exercises its exports, not the repository check.
    callers: [...((/process\.argv\[1\]|import\.meta\.url\s*===/.test(read(file)) ? executions : callers).get(file) ?? [])].sort(),
  }));
}

export function inventoryProblems(rows, inherited, previous) {
  const dark = new Set(rows.filter(row => !row.callers.length).map(row => row.file));
  return [
    ...[...dark].filter(file => !(file in inherited)).map(file => `${file}: no caller from required CI`),
    ...Object.entries(inherited).flatMap(([file, reason]) => [
      ...(!reason?.trim() ? [`${file}: orphan exception needs a reason`] : []),
      ...(!dark.has(file) ? [`${file}: remove stale orphan exception`] : []),
    ]),
    ...Object.keys(inherited).filter(file => previous && !(file in previous)).map(file => `${file}: orphan catalog must only shrink`),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const root = process.argv.includes("--root") ? path.resolve(process.argv[process.argv.indexOf("--root") + 1]) : path.resolve(import.meta.dirname, "..");
    const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
    const read = file => readFileSync(path.join(root, file), "utf8");
    const rows = inventory(files, read);
    const inherited = existsSync(path.join(root, baselineFile)) ? JSON.parse(read(baselineFile)).orphans : {};
    const previous = existsSync(path.join(root, baselineFile)) ? atBase(root, qualityRef(root), baselineFile) : undefined;
    const problems = inventoryProblems(rows, inherited, previous ? JSON.parse(previous).orphans : undefined);
    for (const row of rows) process.stdout.write(`${row.file}: ${row.callers.join(", ") || `ORPHAN — ${inherited[row.file] ?? "unexplained"}`}\n`);
    process.stdout.write(`script reachability: ${rows.length} inventoried, ${rows.filter(row => row.callers.length).length} reached, ${Object.keys(inherited).length} inherited orphans\n`);
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.exitCode = problems.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error}\n`);
    process.exitCode = 1;
  }
}
