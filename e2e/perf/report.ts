// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type ColdRow = { route: string; cache: string; protocol: string; lcp_p95_ms: number | null; status: string; sample_count: number };

/** PR-ready comparison; keep unknowns and failures visible alongside the measured tails. */
export function comparison(rows: ColdRow[]) {
  const cold = rows.filter(row => row.cache === "cold");
  const lines = ["| Route | HTTP/1.1 cold p95 LCP (ms) | HTTP/2 cold p95 LCP (ms) |", "| --- | --- | --- |"];
  for (const route of new Set(cold.map(row => row.route))) {
    const cells = ["http/1.1", "h2"].map(protocol => {
      const row = cold.find(row => row.route === route && row.protocol === protocol);
      return row ? `${row.lcp_p95_ms ?? "unknown"} (${row.status}, n=${row.sample_count})` : "unknown (missing)";
    });
    lines.push(`| ${route} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
  process.stdout.write(comparison(report.rows));
}
