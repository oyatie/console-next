import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { Table, type Column } from "../../ui/table";
import { Chip } from "../../ui/chip";
import { EMPLOYEE_STATUS, labeled } from "../../lib/labels";
import { Section } from "../Section";

export const order = 20;

type Row = { id: string; name: string; unit: string; position: string; status: "ACTIVE" | "ON_LEAVE" | "EXITED" | "UNKNOWN" };
const STATUSES = ["ACTIVE", "ON_LEAVE", "EXITED", "UNKNOWN"] as const;

export default function Tables() {
  const [selected, setSelected] = useState("r2");
  const rows: Row[] = Array.from({ length: 8 }, (_, i) => ({
    id: `r${i}`,
    name: i === 3 ? tg("sample.longName") : tg("sample.person", { n: i + 1 }),
    unit: i === 3 ? tg("sample.teamLong") : tg("sample.team"),
    position: i === 3 ? tg("sample.longPosition") : tg("sample.position"),
    status: STATUSES[i % STATUSES.length]!,
  }));
  const columns: Column<Row>[] = [
    { header: tg("col.name"), cell: (r) => r.name },
    { header: tg("col.unit"), cell: (r) => r.unit },
    { header: tg("col.position"), cell: (r) => r.position },
    { header: tg("col.status"), card: "status", fit: true, cell: (r) => { const s = labeled(EMPLOYEE_STATUS, r.status); return <Chip tone={s.tone}>{s.label}</Chip>; } },
  ];
  return (
    <Section title={tg("section.tables")}>
      <Table label={tg("table.empty")} rows={[]} columns={columns} rowId={(r) => r.id} />
      <Table label={tg("table.one")} rows={rows.slice(0, 1)} columns={columns} rowId={(r) => r.id} />
      <Table label={tg("table.many")} groups={STATUSES.map(status => ({ id: status, header: labeled(EMPLOYEE_STATUS, status).label, rows: rows.filter(r => r.status === status) }))} rows={rows} columns={columns} rowId={(r) => r.id} selected={selected} onSelect={setSelected} />
    </Section>
  );
}
