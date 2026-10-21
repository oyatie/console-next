export function parseStructFields(body) {
  const fields = [];
  let pendingRename = null;
  let pendingDefault = false;
  let pendingFlatten = false;
  let pendingDeserializeWith = null;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#[")) {
      pendingRename = line.match(/\brename\s*=\s*"([^"]+)"/)?.[1] ?? pendingRename;
      pendingDeserializeWith = line.match(/\bdeserialize_with\s*=\s*"([^"]+)"/)?.[1] ?? pendingDeserializeWith;
      if (/\bdefault\b/.test(line)) pendingDefault = true;
      if (/\bflatten\b/.test(line)) pendingFlatten = true;
      continue;
    }
    if (line.startsWith("//") || line === "") continue;
    const field = line.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:r#)?([a-z0-9_]+)\s*:\s*(.+?),?$/);
    if (field) {
      fields.push({
        name: field[1],
        type: field[2],
        rename: pendingRename,
        hasDefault: pendingDefault,
        flatten: pendingFlatten,
        deserializeWith: pendingDeserializeWith,
      });
    }
    pendingRename = null;
    pendingDefault = false;
    pendingFlatten = false;
    pendingDeserializeWith = null;
  }
  return fields;
}

// Flattened structs share the containing wire object; maps and cycles stay undecidable.
export function expandFlattenedFields(struct, lookup, renameField, seen = new Set()) {
  if (seen.has(struct)) return null;
  const next = new Set(seen).add(struct);
  const fields = [];
  for (const field of struct.fields) {
    if (!field.flatten) { fields.push(field); continue; }
    const child = lookup(struct, field.type);
    const expanded = child && expandFlattenedFields(child, lookup, renameField, next);
    if (!expanded) return null;
    for (const nested of expanded.fields) fields.push({ ...nested,
      rename: nested.rename ?? renameField(nested.name, child.renameAll),
      hasDefault: field.hasDefault || nested.hasDefault });
  }
  const names = fields.map(f => f.rename ?? renameField(f.name, struct.renameAll));
  if (new Set(names).size !== names.length) return null;
  return { ...struct, fields };
}
