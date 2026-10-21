import { useNavigate } from "@tanstack/react-router";
import { FileText, Lock, Pencil, Undo2 } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { daysBetween, retentionEnd } from "../domain/roster";
import s from "./roster.module.css";

/**
 * The peek of someone exited (E9-exited): read only, the retention the law sets (keep until = exit date + 3 years) and what happens
 * past it (review, never deleted on its own), then the other ways on: a certificate, a register correction. Undoing an exit is
 * listed with why it is closed (no exit rescind on the server yet).
 */
export function ExitPeek({ id, exitDate, today }: { id: string; exitDate: string; today: string }) {
  const navigate = useNavigate();
  const end = retentionEnd(exitDate);
  const left = daysBetween(today, end);
  const act = (a: string) => void navigate({ to: "/people/$id", params: { id }, search: { act: a } });
  return (
    <>
      <p className={s.peekKept}><Lock size={13} aria-hidden /> {t("roster.exitPeek.kept")}</p>
      <dl className={s.peekBox}>
        <div><dt className={s.peekTerm}>{t("roster.exitPeek.until")}</dt><dd><b>{t("roster.exitPeek.untilValue", { date: fmtDate(end), days: left })}</b></dd></div>
        <div><dt className={s.peekTerm}>{t("roster.exitPeek.after")}</dt><dd>{t("roster.exitPeek.afterValue")}</dd></div>
        <div><dt className={s.peekTerm}>{t("roster.exitPeek.fix")}</dt><dd>{t("roster.exitPeek.fixValue")}</dd></div>
      </dl>
      <section aria-labelledby="exit-ways">
        <h3 id="exit-ways" className={s.peekTitle}>{t("roster.exitPeek.ways")}</h3>
        <ul className={s.ways}>
          <li className={s.way}><Button onClick={() => act("cert")}><FileText size={14} aria-hidden /> {t("roster.exitPeek.cert")}</Button><span>{t("roster.exitPeek.cert.d")}</span></li>
          <li className={s.way}><Button onClick={() => act("multi")}><Pencil size={14} aria-hidden /> {t("roster.exitPeek.correct")}</Button><span>{t("roster.exitPeek.correct.d")}</span></li>
          <li className={s.way}><Button aria-disabled onClick={() => undefined}><Undo2 size={14} aria-hidden /> {t("roster.exitPeek.unexit")}</Button><span>{t("roster.exitPeek.unexit.d")}</span></li>
        </ul>
      </section>
    </>
  );
}
