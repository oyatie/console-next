import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Checks } from "../../../ui/choice/checks";
import { EmptyState } from "../../../ui/empty-state";
import { Table } from "../../../ui/table";
import { crewsQuery, type Crew, type ScheduleTree } from "../api";
import { dateText, peopleText } from "../present";
import type { AssignTarget } from "./assign-sheet";
import { CrewMembersSheet } from "./crew-members-sheet";
import { CrewSheet } from "./crew-sheet";
import s from "./attendance.module.css";

const today = () => todayKst();

/**
 * A2-crews: crew are people who rotate together across department (their department placement is unchanged). Each has a dated roster; a
 * rotation goes to several crew at once, each with its own rotation start (three crews offset by days 1, 3 and 5).
 */
export function CrewsView({ tree, onAssign, onDone }: { tree: ScheduleTree; onAssign: (targets: AssignTarget[]) => void; onDone: (message: string) => void }) {
  const q = useQuery(crewsQuery(undefined, today()));
  const [picked, setPicked] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>();
  const [open, setOpen] = useState<"crew" | Crew | null>(null);
  const workplaces = tree.nodes.filter((n) => n.kind === "WORKPLACE");
  const active = (q.data?.items ?? []).filter((c) => c.status === "ACTIVE");
  const crew = active.find((c) => c.id === selected);
  const current = (c: Crew) => c.members.filter((m) => m.valid_from <= today() && (!m.valid_to || m.valid_to > today()));
  const targets = (ids: string[]) => active.filter((c) => ids.includes(c.id)).map((c) => ({ kind: "CREW" as const, id: c.id, name: c.name }));
  return (
    <>
      <Card
        title={t("attendanceCrews.crews.title")}
        meta={t("attendanceCrews.crews.meta")}
        flush
        tools={
          <>
            {picked.length > 0 && <Button size="sm" onClick={() => onAssign(targets(picked))}>{t("attendanceCrews.crews.assignPicked", { count: picked.length })}</Button>}
            <Button size="sm" variant={active.length ? "secondary" : "primary"} onClick={() => setOpen("crew")}><Plus size={16} aria-hidden /> {t("attendanceCrews.crews.add")}</Button>
          </>
        }
      >
        <QueryState q={q} empty={() => (active.length ? null : <EmptyState title={t("attendanceCrews.crews.none")} reason={t("attendanceCrews.crews.none.reason")} actions={<Button variant="primary" onClick={() => setOpen("crew")}>{t("attendanceCrews.crews.add")}</Button>} />)}>
          {() => (
            <>
              <div className={s.checks}>
                <Checks label={t("attendanceCrews.crews.pick")} required={false} items={active.map((c) => ({ id: c.id, label: c.name }))} value={picked} onChange={setPicked} />
              </div>
              <Table
                label={t("attendanceCrews.crews.title")}
                rows={active}
                rowId={(c) => c.id}
                selected={selected}
                onSelect={setSelected}
                columns={[
                  { header: t("attendanceCrews.crews.col.name"), cell: (c) => <><strong>{c.name}</strong><br /><span className="muted">{c.workplace_name}</span></> },
                  { header: t("attendanceCrews.crews.col.people"), cell: (c) => <span className="num">{peopleText(current(c).length)}</span>, fit: true },
                  { header: t("attendanceCrews.crews.col.schedule"), cell: (c) => (c.layer ? t("attendanceCrews.crews.layer", { pattern: c.layer.pattern_name, from: dateText(c.layer.effective_from) }) : <span className="muted">{t("attendanceCrews.crews.noLayer")}</span>) },
                  { header: t("attendanceCrews.crews.col.actions"), fit: true, cell: (c) => <Button size="sm" variant="ghost" onClick={() => onAssign(targets([c.id]))}>{t("attendanceSchedule.assign.open")}</Button> },
                ]}
              />
            </>
          )}
        </QueryState>
      </Card>
      {crew && (
        <Card title={t("attendanceCrews.crews.members", { name: crew.name, count: current(crew).length })} meta={t("attendanceCrews.crews.members.meta")} flush tools={<Button size="sm" onClick={() => setOpen(crew)}><Plus size={16} aria-hidden /> {t("attendanceCrews.crews.addPeople")}</Button>}>
          {crew.members.length ? (
            <Table
              label={t("attendanceCrews.crews.members", { name: crew.name, count: crew.members.length })}
              rows={crew.members}
              rowId={(m) => `${m.employee_id}-${m.valid_from}`}
              columns={[
                { header: t("attendanceCrews.crews.col.number"), cell: (m) => <span className="num">{m.employee_number ?? "—"}</span>, fit: true },
                { header: t("attendanceCrews.crews.col.person"), cell: (m) => m.name },
                { header: t("attendanceCrews.crews.col.period"), cell: (m) => <span className="num">{m.valid_to ? t("attendanceSchedule.history.range", { from: dateText(m.valid_from), to: dateText(m.valid_to) }) : t("attendanceSchedule.history.from", { from: dateText(m.valid_from) })}</span> },
              ]}
            />
          ) : (
            <EmptyState title={t("attendanceCrews.crews.noMembers")} reason={t("attendanceCrews.crews.noMembers.reason")} />
          )}
        </Card>
      )}
      <CrewSheet open={open === "crew"} workplaces={workplaces} onClose={() => setOpen(null)} onAdded={(c) => (setOpen(null), setSelected(c.id), onDone(t("attendanceCrews.crews.added", { name: c.name })))} />
      <CrewMembersSheet crew={open && open !== "crew" ? open : null} onClose={() => setOpen(null)} onPlaced={(message) => (setOpen(null), onDone(message))} />
    </>
  );
}
