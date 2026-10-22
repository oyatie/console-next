#!/usr/bin/env node
// Entity names gate (0h): an entity's name reaches the screen only through the one presentation in
// apps/web/src/reference/entity/domain/names.ts (entityNames / entityName, and <EntityName> on it), so the English UI
// shows the same name on every surface. It refuses every read of a LegalEntityState's `name` (`e.current?.name`, a
// destructured `{ name }`) outside that module, found by the type checker (by shape, so a response type derived from the schema counts) rather than by spelling, so a workplace's
// `current.name` passes and a renamed variable does not hide an entity's.
// ALLOW pins the reads where the 법인명 itself is the fact, never a label: file -> exact count, so a new read in an
// allowed file fails too, and a read that goes away fails until its pin goes with it.
// File paths given as arguments are checked too (the planted control in scripts/gates.test.ts).
// property access and object destructuring only; e.current["name"] is not seen.
import ts from "typescript";
import path from "node:path";

const HOME = "apps/web/src/reference/entity/domain/names.ts";
const ALLOW = {
  "apps/web/src/features/entity/domain/view.ts": [1, "a dated revision's input sends the 법인명 back"],
  "apps/web/src/features/entity/ui/record-entity-fields.tsx": [1, "the 법인명 field's own value, for its edit"],
  "apps/web/src/features/entity/ui/record-registry-card.tsx": [1, "the 법인명 row (no certificate), beside the 약칭 and 영문명 rows"],
  "apps/web/src/features/entity/ui/name-correction-spec.tsx": [1, "a 법인명 correction keeps the old 법인명"],
  "apps/web/src/features/org-bulk/domain/values.ts": [1, "a pasted name is matched against every name fact"],
};

const root = process.cwd();
const rel = (f) => path.relative(root, f).split(path.sep).join("/");
const cfg = ts.getParsedCommandLineOfConfigFile(path.join(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
const planted = process.argv.slice(2).map((f) => path.resolve(f));
const app = (f) => rel(f).startsWith("apps/web/src/");
const SCHEMA = path.join(root, "packages/api/src/schema.d.ts");
const program = ts.createProgram({ rootNames: [...cfg.fileNames.filter(app), SCHEMA, ...planted], options: { ...cfg.options, incremental: false, noEmit: true } });
const checker = program.getTypeChecker();
// The generated schema's LegalEntityState (`current`, `scheduled` and every revision of an entity), matched by shape: a
// response type openapi-fetch derives from it (`unwrap(api.POST(...)).record.current`) loses the link to its declaration.
let state;
const find = (n) => (ts.isPropertySignature(n) && n.name.getText() === "LegalEntityState" && n.type ? (state = checker.getTypeFromTypeNode(n.type)) : ts.forEachChild(n, find));
const schema = program.getSourceFile(SCHEMA);
if (!schema) throw new Error(`entity names: schema not loaded from ${rel(SCHEMA)}`);
find(schema);
if (!state) throw new Error(`entity names: no LegalEntityState in ${rel(SCHEMA)}`);
// any and never are assignable to every type; they are not an entity's state.
const isState = (t) => (t.isUnion() ? t.types : [t]).some((u) => !(u.flags & (ts.TypeFlags.Any | ts.TypeFlags.Never | ts.TypeFlags.Nullable)) && checker.isTypeAssignableTo(u, state));

const reads = new Map();
for (const sf of program.getSourceFiles()) {
  if (!app(sf.fileName) && !planted.includes(path.resolve(sf.fileName))) continue;
  const f = rel(sf.fileName);
  if (f === HOME) continue;
  const visit = (n) => {
    const hit =
      (ts.isPropertyAccessExpression(n) && n.name.text === "name" && isState(checker.getTypeAtLocation(n.expression))) ||
      (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) && (n.propertyName ?? n.name).getText() === "name" && isState(checker.getTypeAtLocation(n.parent)));
    if (hit) reads.set(f, [...(reads.get(f) ?? []), `${f}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${n.getText()}`]);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

const problems = [];
for (const [f, sites] of reads) {
  const pin = ALLOW[f]?.[0] ?? 0;
  if (sites.length !== pin) problems.push(...sites.map((s) => `${s}  (${pin ? `pinned ×${pin} for "${ALLOW[f][1]}", found ×${sites.length}` : "show an entity's name with entityName/entityNames or <EntityName>"})`));
}
for (const f of Object.keys(ALLOW)) if (!reads.has(f)) problems.push(`${f}: stale ALLOW entry (no 법인명 read left; delete it)`);
if (problems.length) {
  console.log(`entity names: ${problems.length} problem(s):\n${problems.join("\n")}`);
  process.exit(1);
}
