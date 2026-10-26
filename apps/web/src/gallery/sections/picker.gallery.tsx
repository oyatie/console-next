import { useMemo, useState } from "react";
import type { components } from "@console/api";
import { tg } from "@console/i18n/gallery";
import { UnitPicker } from "../../reference/org/ui/unit-picker";
import { PickOne } from "../../reference/entity/ui/pick-one";
import { ServerPicker } from "../../ui/server-picker/server-picker";
import { PICK_SIZE_THRESHOLD } from "../../ui/server-picker/size";
import { Section } from "../Section";

export const order = 70;

type Unit = components["schemas"]["OrgUnitHead"];
const AT = "2026-09-01T00:00:00Z";
const unit = (id: string, kind: Unit["kind"], name: string, parentId: string | null): Unit => ({
  id, kind, name, parentId, status: "ACTIVE", effectiveFrom: "2026-01-01", headcount: 0, updatedAt: AT,
});

export default function Picker() {
  const [unitId, setUnitId] = useState("");
  const [query, setQuery] = useState("");
  const [personId, setPersonId] = useState<string | null>(null);
  const [smallId, setSmallId] = useState<string | null>(null);
  const [largeId, setLargeId] = useState<string | null>(null);
  const people = useMemo(() => Array.from({ length: 2000 }, (_, i) => ({
    value: `EMP${String(i + 1).padStart(5, "0")}`, label: tg("sample.person", { n: i + 1 }),
  })), []);
  const matches = people.filter(p => `${p.label} ${p.value}`.includes(query.trim()));
  // Stable identities: the picker's collection rebuilds when its items change.
  const units = useMemo(() => [
    unit("c", "COMPANY", tg("sample.company"), null),
    unit("s", "SITE", tg("sample.site"), "c"),
    unit("d", "DEPARTMENT", tg("sample.dept"), "s"),
    unit("t1", "TEAM", tg("sample.team"), "d"),
    unit("t2", "TEAM", tg("sample.teamLong"), "d"),
  ], []);
  const options = useMemo(() => units.filter((u) => u.kind !== "COMPANY"), [units]);
  return (
    <Section title={tg("section.picker")}>
      <UnitPicker units={units} options={options} value={unitId} onChange={setUnitId} />
      <div className="grid-3">
        <PickOne label={tg("picker.list", { count: PICK_SIZE_THRESHOLD })} required={false}
          options={people.slice(0, PICK_SIZE_THRESHOLD)} value={smallId} onChange={setSmallId}
          group={tg("col.name")} empty={tg("empty.reason")} />
        <PickOne label={tg("picker.search", { count: PICK_SIZE_THRESHOLD + 1 })} required={false}
          options={people.slice(0, PICK_SIZE_THRESHOLD + 1)} value={largeId} onChange={setLargeId}
          group={tg("col.name")} empty={tg("empty.reason")} />
        <ServerPicker label={tg("picker.search", { count: people.length })}
          query={query} onQueryChange={setQuery} value={personId} onChange={setPersonId}
          options={matches.slice(0, 50).map(p => ({ id: p.value, name: p.label, code: p.value }))}
          total={matches.length} group={tg("col.name")} empty={tg("empty.reason")} />
      </div>
    </Section>
  );
}
