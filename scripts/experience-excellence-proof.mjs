#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const document = readFileSync(resolve(root, "docs/design/experience-excellence.md"), "utf8");

// Static evidence checks cannot establish source meaning, production performance or browser conformance.
function inspect(text) {
  assert(text.split("\n").length <= 300, "document exceeds repository size limit");
  const dimensions = [...text.matchAll(/^## ([1-7])\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(dimensions, [1, 2, 3, 4, 5, 6, 7], "seven dimensions required");
  const sources = new Map([...text.matchAll(/^\[([a-z-]+)\]: (https:\/\/\S+)/gm)].map((m) => [m[1], m[2]]));
  for (const [, source] of text.matchAll(/\[[^\]\n]+\]\[([a-z-]+)\]/g))
    assert(sources.has(source), `undefined primary-source reference: ${source}`);
  const citations = [...text.matchAll(/`((?:apps|packages|scripts|docs|e2e)\/[^`\s]+):(\d+)`/g)];
  assert(citations.length > 0, "local evidence citations required");
  for (const [, path, number] of citations) {
    assert(!path.split("/").includes(".."), "citation must stay in the repository");
    const lines = readFileSync(resolve(root, path), "utf8").split("\n");
    const line = Number(number);
    assert(line > 0 && line <= lines.length && lines[line - 1].trim(), `invalid local anchor: ${path}:${number}`);
  }
  const ranks = [...text.matchAll(/^\| (\d+) \| (E\d{2}) \/ ([a-z-]+) \| ([^|]+) \| (\d+) \| (\d+) \| ([\d.]+) \|$/gm)];
  assert.equal(ranks.length, 10, "ten ranked work items required");
  const ids = ranks.map((m) => m[2]);
  assert.equal(new Set(ids).size, 10, "work IDs must be unique");
  ranks.forEach((m, i) => {
    assert.equal(Number(m[1]), i + 1, "ranks must be contiguous");
    const ratio = Number(m[5]) / Number(m[6]);
    assert.equal(Number(m[7]), Number(ratio.toFixed(2)), "rank ratio must match impact / effort");
    if (i) assert(ratio <= Number(ranks[i - 1][5]) / Number(ranks[i - 1][6]), "rank ratios must descend");
  });
  const briefs = [...text.matchAll(/^### (E\d{2}) — ([a-z-]+) \((\d+) days\)\n\n([\s\S]*?)(?=\n\n##|(?![\s\S]))/gm)];
  assert.deepEqual(briefs.map((m) => m[1]), ids, "queue briefs must follow ranking");
  briefs.forEach((m, i) => {
    assert.equal(m[2], ranks[i][3], "brief owner must match ranking");
    assert.equal(m[3], ranks[i][6], "brief effort must match ranking");
    assert(m[0].trimEnd().split("\n").length <= 15, `brief ${m[1]} exceeds 15 lines`);
    for (const field of ["Ideal", "Own", "RULES", "Proof", "Done"])
      assert(new RegExp(`^${field}:`, "m").test(m[4]), `brief ${m[1]} lacks ${field}`);
  });
  const practices = text.split("\n").filter((line) => line.startsWith("| ") && line.includes("→") && !line.startsWith("| Practice →"));
  assert(practices.length > 0, "practice matrix required");
  const counts = { have: 0, partial: 0, missing: 0 };
  for (const row of practices) {
    const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
    assert.equal(cells.length, 4, "practice row must have four columns");
    assert(Object.hasOwn(counts, cells[2]), "practice status must be have / partial / missing");
    assert(/\[[^\]]+\]\[[a-z-]+\]/.test(cells[0]), "practice requires primary-source reference");
    assert(/`[^`]+:\d+`/.test(cells[1]), "practice requires local evidence");
    if (cells[2] !== "have") {
      const work = [...cells[3].matchAll(/\bE\d{2}\b/g)].map((m) => m[0]);
      assert(work.length && work.every((id) => ids.includes(id)), "every gap requires a ranked owner brief");
    }
    counts[cells[2]]++;
  }
  return { citations: citations.length, sources: sources.size, practices: practices.length, counts, briefs: briefs.length };
}

const result = inspect(document);
const controls = [
  ["bad local anchor", "apps/web/src/main.tsx:49", "apps/web/src/main.tsx:99999"],
  ["missing source", "[meta-web]:", "[unknown-source]:"],
  ["unrecognized status", "| partial |", "| green |"],
  ["unmatched brief", "### E01 —", "### E99 —"],
  ["missing refusal proof", "Proof: planted ASCII/Korean names", "Evidence: planted ASCII/Korean names"],
  ["wrong ranking", "5 | 2 | 2.50", "5 | 2 | 9.99"],
  ["unowned gap", "E05: principal-scoped recovery", "E99: principal-scoped recovery"],
  ["missing dimension", "## 7. Engineering", "## Engineering"],
];
for (const [name, before, after] of controls) {
  assert(document.includes(before), `negative control ${name} is stale`);
  assert.throws(() => inspect(document.replace(before, after)), undefined, `negative control ${name} must fail`);
}
console.log(JSON.stringify({ ...result, negativeControlsRejected: controls.length }));
