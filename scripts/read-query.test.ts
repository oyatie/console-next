// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { routeList } from "../e2e/helpers/route-list";
import { readQuery } from "../e2e/helpers/read-query";

const yaml = createRequire(import.meta.url)("js-yaml");
type Parameter = { in: string; name: string; required?: boolean };
const contract = yaml.load(readFileSync("backend/openapi/openapi.yaml", "utf8")) as {
  paths: Record<string, { get?: { parameters?: Parameter[] } }>;
};
const normalized = (path: string) => path.replace(/\{[^}]+\}|\$[^/]+/g, "$id");
const operations = new Map(Object.entries(contract.paths).map(([path, operation]) => [normalized(path), operation.get]));

for (const read of new Set(routeList.flatMap(route => route.reads))) {
  const required = operations.get(normalized(read))?.parameters?.filter(parameter => parameter.in === "query" && parameter.required) ?? [];
  if (!required.length) continue;
  test(`protected read ${read} supplies every required query parameter`, () => {
    const query = readQuery(read, "00000000-0000-4000-8000-000000000001");
    for (const parameter of required) expect(query[parameter.name], parameter.name).toBeTruthy();
  });
}
