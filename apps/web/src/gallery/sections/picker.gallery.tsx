import { useMemo, useState } from "react";
import type { components } from "@console/api";
import { tg } from "@console/i18n/gallery";
import { UnitPicker } from "../../reference/org/ui/unit-picker";
import { Section } from "../Section";

export const order = 70;

type Unit = components["schemas"]["OrgUnitHead"];
const AT = "2026-09-01T00:00:00Z";
const unit = (id: string, kind: Unit["kind"], name: string, parentId: string | null): Unit => ({
  id, kind, name, parentId, status: "ACTIVE", effectiveFrom: "2026-01-01", headcount: 0, updatedAt: AT,
});

export default function Picker() {
  const [unitId, setUnitId] = useState("");
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
    </Section>
  );
}
