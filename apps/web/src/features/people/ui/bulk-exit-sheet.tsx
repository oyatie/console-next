import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { todayKst } from "../../../lib/pure/today";
import { refusalText } from "../../../reference/crud/present";
import { Button, Form } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { Sheet } from "../../../ui/sheet/sheet";
import { reportExits, type BulkExitRow } from "../api";

const NOTE_MAX = 1000;

/**
 * exit for the people picked on the roster (CRUD; bulk equals one-by-one): one last working day and one note, then one report
 * each with the same server checks as the record's own exit report. Each person's answer is listed — reported, or refused
 * with its reason (an open case, a exit date before the hire date, no permission) — and the cases continue in the exits list.
 */
export function BulkExitSheet({ picked, onClose }: { picked: Map<string, string>; onClose: () => void }) {
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const [rows, setRows] = useState<BulkExitRow[] | null>(null);
  // One intent key per person, kept across a retry of the same submission (a lost answer replays, never reports twice).
  const keys = useRef(new Map<string, string>());
  const people = [...picked].map(([id, name]) => ({ id, name }));
  const missing = !date || !note.trim();
  const run = useCommand({
    run: () => reportExits(people, date, note.trim(), keys.current),
    invalidates: ["/api/v1/employees", "/api/v1/hr/exit-cases"],
    onSuccess: setRows,
  });
  const submit = () => {
    setTried(true);
    if (!missing) run.mutate(undefined);
  };
  const busy = run.isPending;
  const ok = rows?.filter((r) => r.ok).length ?? 0;
  return (
    <Sheet
      open
      kicker={<><LogOut size={14} aria-hidden />{t("crud.bulkExit.kicker", { count: people.length })}</>}
      title={t("crud.bulkExit.title", { count: people.length })}
      subtitle={t("crud.bulkExit.subtitle")}
      onClose={onClose}
      pending={busy}
      notice={<CommandError error={run.error} />}
      consequence={rows ? <span role="status">{t("crud.bulkExit.done", { ok, refused: rows.length - ok })}</span> : <span>{date ? t("crud.bulkExit.consequence", { count: people.length, date: fmtDate(date) }) : t("crud.bulkExit.needDate")}</span>}
      actions={
        rows ? (
          <>
            <Link className="btn" to="/people/exits" search={{}}>{t("crud.bulkExit.openList")}</Link>
            <Button variant="primary" onClick={onClose}>{t("crud.close")}</Button>
          </>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>{t("common.back")}</Button>
            <Button variant="danger" id="crud-bulk-exit" disabled={busy} onClick={submit}>{t("crud.bulkExit.commit", { count: people.length })}</Button>
          </>
        )
      }
    >
      {rows ? (
        <ul className="list-plain" aria-label={t("crud.bulkExit.results")}>
          {rows.map((r) => (
            <li key={r.id} className="row">
              <span className="grow">{r.name}</span>
              <span className={r.ok ? undefined : "muted"}>{r.ok ? t("crud.bulkExit.reported") : (refusalText(r.code) ?? t("crud.refused.unknown"))}</span>
            </li>
          ))}
        </ul>
      ) : (
        <Form className="form" onSubmit={submit}>
          <DateField label={t("exit.field.date")} required value={date} onChange={setDate} today={todayKst()} error={tried && !date ? t("exit.error.date") : undefined} />
          <Field label={t("exit.field.note")} required hint={t("exit.field.count", { count: note.length, max: NOTE_MAX })} error={tried && !note.trim() ? t("exit.error.text") : undefined}>
            {(p) => <TextArea {...p} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <p className="muted">{people.map((p) => p.name).join(" · ")}</p>
        </Form>
      )}
    </Sheet>
  );
}
