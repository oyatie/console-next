#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Timestamp-named values must never use Rust Display, including audit JSON and CSV exports.
export function timestampDisplayProblems(file, source) {
  const timestamp = String.raw`\b\w+_at\b`;
  const patterns = [
    new RegExp(String.raw`${timestamp}\s*\.\s*to_string\s*\(\s*\)`, "g"),
    new RegExp(String.raw`${timestamp}\s*\.\s*map\s*\(\s*\|\s*(\w+)\s*\|\s*(?:\{\s*)?\1\s*\.\s*to_string\s*\(\s*\)`, "g"),
    new RegExp(String.raw`format!\s*\(\s*"\{${timestamp}(?::[^}]*)?\}"`, "g"),
    new RegExp(String.raw`format!\s*\(\s*"\{\}"\s*,\s*(?:\w+\s*\.\s*)*${timestamp}\s*\)`, "g"),
    new RegExp(String.raw`(?:"${timestamp}"|${timestamp})\s*:\s*(?:format!\s*\([^;\n]*\)|(?:\w+\s*\.\s*)*\w+\s*\.\s*to_string\s*\(\s*\))`, "g"),
  ];
  return [...new Set(patterns.flatMap(pattern => [...source.matchAll(pattern)].map(match =>
    `${file}:${source.slice(0, match.index).split("\n").length}: timestamp Display conversion; use UTC RFC 3339 serialization`)))];
}

export function checkTimestampDisplay(root = process.cwd()) {
  const walk = dir => readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return ["tests", "fixtures", "migrations"].includes(entry.name) ? [] : walk(file);
    if (!entry.name.endsWith(".rs") || /(?:_tests|_test)\.rs$/.test(entry.name)) return [];
    return timestampDisplayProblems(file, readFileSync(path.join(root, file), "utf8"));
  });
  return ["backend/app/src", "backend/crates"].flatMap(walk);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkTimestampDisplay(process.argv[2]);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  } else console.log("timestamp-display: no Display-formatted timestamps");
}
