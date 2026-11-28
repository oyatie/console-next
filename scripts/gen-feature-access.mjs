// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { alternativeRouteReads, routeReads } from "../apps/web/src/routes/route-read-data.ts";
import { actionRegistry } from "./d10-census.mjs";

const root = new URL("../", import.meta.url);
export const output = new URL("apps/web/src/reference/authz/domain/feature-access.ts", root);
export const operationOutput = new URL("apps/web/src/reference/authz/domain/operation-access.ts", root);
export const routeOperationOutput = new URL("apps/web/src/routes/route-operation-access.ts", root);
const yaml = createRequire(import.meta.url)("js-yaml");
const source = file => readFileSync(new URL(`backend/crates/${file}`, root), "utf8");
const upper = value => value.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();

/** Scope names come from OpenAPI; reach and branch projection come from the server. */
export function operationAccess(spec = yaml.load(readFileSync(new URL("backend/openapi/openapi.yaml", root), "utf8"))) {
  const enrolled = new Map([...actionRegistry(file => source(`platform/authz/src/${file}`))
    .matchAll(/Self::(\w+)\s*=>\s*"([^"]+)"/g)].map(([, feature, action]) => [feature, action]));
  const kinds = spec.components.schemas.AccessScopeKind.enum;
  const branches = source("platform/authz/src/access/load.rs");
  const projected = [...branches.matchAll(/NodeKind::(\w+) => (?:BranchScope::All|\{)/g)].map(([, kind]) => upper(kind));
  if (!branches.includes("attach_entity_branches(tx, org, &mut held)")) throw new Error("Branch projection changed");
  const attached = branches.split("async fn attach_entity_branches")[1]?.match(/n.kind == NodeKind::(\w+)/)?.[1];
  if (!attached || !projected.length) throw new Error("Capability scopes missing");
  const scopes = {
    any: kinds,
    hr: [...source("hr/adapter-postgres/src/authz_reach.rs").split("fn scope_of")[1].split("Some(out)")[0].matchAll(/NodeKind::(\w+) =>/g)].map(([, kind]) => upper(kind)),
    entity: entityReadAccess().scopes,
    capability: kinds.filter(kind => [...projected, upper(attached)].includes(kind)),
    tenant: [...branches.matchAll(/NodeKind::(\w+) => BranchScope::All/g)].map(([, kind]) => upper(kind)),
    ops: [],
  };
  return Object.fromEntries(Object.entries(spec.paths).flatMap(([path, methods]) => Object.entries(methods).flatMap(([method, op]) => {
    const auth = op["x-console-authz"];
    if (!auth) return [];
    if (auth.engine === "cedar" && auth.action && auth.permission) {
      if (enrolled.get(auth.permission) !== auth.action || !["self", "tenant"].includes(auth.scope))
        throw new Error(`Invalid Cedar action contract: ${method} ${path}`);
      // These actions require server facts and cannot be projected into a browser grant rule.
      return [];
    }
    if (auth.action) {
      if (auth.permission || auth.scope !== "tenant" || !Object.hasOwn(spec.components.schemas.AccessEffective.properties.decisions.properties, auth.action))
        throw new Error(`Invalid Cedar action contract: ${method} ${path}`);
      return [[`${method.toUpperCase()} ${path}`, { action: auth.action }]];
    }
    const allowed = scopes[auth.scope];
    const permissions = auth.permissions ?? [auth.permission];
    if (!Array.isArray(permissions) || !permissions.length || (auth.permissions && auth.permission)) throw new Error(`Invalid permission list: ${method} ${path}`);
    const needs = permissions.map(name => {
      const [domain, level] = name.split(":");
      const permission = featureAccess()[name] ?? (level ? { domain, level } : null);
      if (!permission || !allowed || allowed.some(kind => !kinds.includes(kind)) ||
        !spec.components.schemas.AccessDomain["x-extensible-enum"].includes(permission.domain) ||
        !spec.components.schemas.AccessLevel.enum.includes(permission.level)) throw new Error(`Invalid authz contract: ${method} ${path}`);
      return { ...permission, ...(auth.scope === "tenant" || auth.scope === "ops" ? { tenant: true } : {}), ...(allowed.length !== kinds.length ? { scopes: allowed } : {}) };
    });
    return [[`${method.toUpperCase()} ${path}`, needs.length === 1 ? needs[0] : { destinations: needs }]];
  })));
}

/** The server's exhaustive Feature match owns the permission vocabulary. */
export function featureAccess() {
  const source = readFileSync(new URL("backend/crates/platform/authz/src/access/tags.rs", root), "utf8");
  const snake = value => value.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  const entries = [...source.matchAll(/((?:F::\w+\s*(?:\|\s*)?)+)=>\s*\{?\s*Some\(\(D::(\w+), L::(\w+)\)\)/g)].flatMap(([, features, domain, level]) =>
    [...features.matchAll(/F::(\w+)/g)].map(([, feature]) => [feature, { domain: snake(domain), level: snake(level) }]),
  );
  if (!entries.length) throw new Error("No server feature tags found");
  return Object.fromEntries(entries);
}

/** The entity read's guard and reach own which grant scopes can open its surfaces. */
export function entityReadAccess() {
  const auth = readFileSync(new URL("backend/crates/entity/rest/src/auth.rs", root), "utf8");
  const feature = auth.match(/Need::Read => Feature::(\w+)/)?.[1];
  const caller = source("entity/rest/src/reach.rs");
  if (!caller.includes("granted_scope(subject.reading_nodes())")) throw new Error("Entity read reach no longer uses shared scope grants");
  const reach = source("platform/authz/src/cedar_pbac/facts/scope.rs").split("fn granted_scope")[1]?.split("\nfn ids")[0];
  if (!featureAccess()[feature] || !reach) throw new Error("Entity read guard or reach not found");
  const scopes = [...reach.matchAll(/((?:NodeKind::\w+\s*(?:\|\s*)?)+)=>\s*(?:return None|ids\.push\(id\))/g)]
    .flatMap(([, kinds]) => [...kinds.matchAll(/NodeKind::(\w+)/g)].map(([, kind]) => kind.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()));
  if (!scopes.length) throw new Error("Entity read scopes not found");
  return { ...featureAccess()[feature], scopes };
}

export function generatedFeatureAccess() {
  return `// SPDX-License-Identifier: LicenseRef-Proprietary\n// Generated by node scripts/gen-feature-access.mjs --write from the server's access/tags.rs and entity read guard/reach.\nimport type { Requirement } from "./access";\n\nexport const entityReadAccess = ${JSON.stringify(entityReadAccess(), null, 2)} as const satisfies Requirement;\n`;
}

export function generatedOperationAccess() {
  const entries = Object.entries(operationAccess()).map(([operation, need]) => `  ${JSON.stringify(operation)}: ${JSON.stringify(need)},`).join("\n");
  return `// SPDX-License-Identifier: LicenseRef-Proprietary\n// Generated by node scripts/gen-feature-access.mjs --write from OpenAPI authz, feature tags and server reach.\nimport type { AccessRequirement } from "./access";\n\nexport const operationAccess = {\n${entries}\n} as const satisfies Record<string, AccessRequirement>;\n`;
}

export function generatedRouteOperationAccess() {
  const all = operationAccess();
  const definitions = new Map();
  const entries = Object.entries(routeReads).map(([path, { reads, command }]) => {
    const needs = [...new Set([...reads, ...(command ? [command] : [])].map(operation => {
      if (!all[operation]) throw new Error(`Missing access requirement for ${operation} on ${path}`);
      const key = JSON.stringify(all[operation]);
      if (!definitions.has(key)) definitions.set(key, `r${definitions.size}`);
      return definitions.get(key);
    }))];
    const requirement = needs.length === 1 ? needs[0] : `{ allOf: [${needs.join(", ")}] }`;
    return `  ${JSON.stringify(path)}: ${requirement},`;
  });
  const defs = [...definitions].map(([json, name]) => `const ${name} = ${json} as const satisfies Requirement;`).join("\n");
  return `// SPDX-License-Identifier: LicenseRef-Proprietary\n// Generated by node scripts/gen-feature-access.mjs --write from route-read-data.ts and OpenAPI authz.\nimport type { AccessRequirement, Requirement } from "../reference/authz/domain/access";\n\n${defs}\n\nexport const overtimeReadAccess = ${JSON.stringify(all[alternativeRouteReads["/settings/overtime"]])} as const satisfies AccessRequirement;\n\nexport const routeAccess = {\n${entries.join("\n")}\n} as const satisfies Record<string, AccessRequirement>;\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [file, generate] of [[output, generatedFeatureAccess], [operationOutput, generatedOperationAccess], [routeOperationOutput, generatedRouteOperationAccess]]) {
    if (process.argv.includes("--write")) writeFileSync(file, generate());
    else if (readFileSync(file, "utf8") !== generate()) throw new Error("Access contract drift: node scripts/gen-feature-access.mjs --write");
  }
}
