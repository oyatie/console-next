#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const yaml = createRequire(import.meta.url)("js-yaml");
export const timestampContract = yaml.load(readFileSync(new URL("../backend/openapi/openapi.yaml", import.meta.url), "utf8"));

function resolve(spec, schema) {
  const seen = new Set();
  while (schema?.$ref) {
    if (seen.has(schema.$ref)) throw new Error(`Cyclic schema reference ${schema.$ref}`);
    seen.add(schema.$ref);
    const resolved = schema.$ref.split("/").slice(1).reduce((node, key) => node?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], spec);
    if (!resolved) throw new Error(`Unresolved schema ${schema.$ref}`);
    schema = resolved;
  }
  return schema;
}

// Follow the response's schema, including refs and arrays, regardless of field names.
export function timestampProblems(spec, schema, value, location = "$") {
  schema = resolve(spec, schema);
  if (!schema || value === undefined || (value === null && (schema.nullable || schema.type === "null" || schema.type?.includes("null")))) return [];
  if (schema.format === "date-time") {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
      ? [] : [`${location}: expected UTC RFC 3339 string`];
  }
  const problems = [];
  for (const child of schema.allOf ?? []) problems.push(...timestampProblems(spec, child, value, location));
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives) {
    const candidates = alternatives.filter(child => {
      const resolved = resolve(spec, child);
      const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      if (resolved.type && resolved.type !== type && !(Array.isArray(resolved.type) && resolved.type.includes(type))) return false;
      if (value && type === "object") {
        return (resolved.required ?? []).every(key => Object.hasOwn(value, key)) && Object.entries(resolved.properties ?? {}).every(([key, property]) => {
          const child = resolve(spec, property);
          return !(key in value) || ((!Object.hasOwn(child, "const") || child.const === value[key]) && (!child.enum || child.enum.includes(value[key])));
        });
      }
      return true;
    });
    if (!candidates.length) return [`${location}: unexpected response type`];
    const results = candidates.map(child => timestampProblems(spec, child, value, location));
    if (results.every(result => result.length)) problems.push(...results[0]);
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => problems.push(...timestampProblems(spec, schema.items, item, `${location}[${index}]`)));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) {
      const child = schema.properties?.[key] ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined);
      if (child) problems.push(...timestampProblems(spec, child, item, `${location}.${key}`));
    }
  }
  return problems;
}

export function responseTimestampProblems(spec, route, method, status, body) {
  const pathname = route.split("?")[0];
  const segments = pathname.split("/");
  const template = Object.hasOwn(spec.paths, pathname) ? pathname : Object.keys(spec.paths).find(candidate => {
    const parts = candidate.split("/");
    return parts.length === segments.length && parts.every((part, index) => part === segments[index] || (part.startsWith("{") && part.endsWith("}")));
  });
  const operation = resolve(spec, spec.paths[template]?.[method.toLowerCase()]);
  const response = resolve(spec, operation?.responses?.[status] ?? operation?.responses?.default);
  const schema = response?.content?.["application/json"]?.schema;
  if (!schema) return [];
  return timestampProblems(spec, schema, body);
}

export function checkTimestampContract(spec = timestampContract) {
  const problems = [];
  const visited = new Set();
  function walk(schema, location) {
    schema = resolve(spec, schema);
    if (!schema || typeof schema !== "object" || visited.has(schema)) return;
    visited.add(schema);
    if (schema.format === "date-time") {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.includes("string") || types.some(type => type !== "string" && type !== "null")) problems.push(`${location}: date-time must be a string`);
    }
    for (const [key, value] of Object.entries(schema)) {
      if (value && typeof value === "object") walk(value, `${location}/${key}`);
    }
  }
  for (const [route, operations] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (operation.responses) walk(operation.responses, `${method} ${route}/responses`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkTimestampContract();
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  } else console.log("timestamp-contract: response date-times are strings");
}
