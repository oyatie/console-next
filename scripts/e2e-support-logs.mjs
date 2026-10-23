// SPDX-License-Identifier: LicenseRef-Proprietary
// Test-only VictoriaLogs protocol fixture: consumes the backend's actual JSON log stream.
import { createServer } from "node:http";
import { createInterface } from "node:readline";

export async function supportLogs() {
  const records = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    const query = url.searchParams.get("query") ?? "";
    const match = /^fields\.support_ref:="([0-9a-f]{8}|[0-9a-f]{32})"(\*)? \| (fields |uniq by \()/.exec(query);
    const reference = match?.[1];
    const prefix = match?.[2] === "*";
    if (request.method !== "GET" || url.pathname !== "/select/logsql/query" || !reference || reference.length !== (prefix ? 8 : 32) || url.searchParams.get("limit") !== (prefix ? "2" : "1")) {
      response.writeHead(400).end();
      return;
    }
    const matches = records.filter(r => prefix ? r.support_ref.startsWith(reference) : r.support_ref === reference);
    const rows = [...new Map(matches.map(r => [JSON.stringify(r), r])).values()].slice(0, prefix ? 2 : 1);
    response.setHeader("Content-Type", "application/stream+json");
    response.end(rows.map(r => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [`fields.${k}`, v]))) + "\n").join(""));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/select/logsql/query`,
    observe(stream) {
      return createInterface({ input: stream }).on("line", (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.fields?.message !== "support reference") return;
        const keys = ["support_ref", "trace_id", "release", "route_template", "org_id", "support_ref_at"];
        records.push(Object.fromEntries(keys.map((key) => [key, event.fields[key]])));
      });
    },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
