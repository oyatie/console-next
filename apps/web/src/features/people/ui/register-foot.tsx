import { t } from "@console/i18n";
import type { Draft, Gap } from "../domain/register";
import s from "./register.module.css";

/** The fields a registration needs before it can be sent (a typed value that is not one is a fix, not a fill). */
const REQUIRED: readonly Gap[] = ["name", "hire"];
const names = (gs: readonly Gap[]) => gs.map((g) => t(`register.field.${g}`)).join(" · ");

/**
 * The sheet's foot sentence (spec E3): before a commit attempt, what is still to fill; after one, how many fields to
 * fix (the first has focus); with a possible duplicate, that the choice comes first; once complete, exactly what
 * registering does — who, where, as what status from which date, and the employee number.
 */
export function RegisterFoot({ d, gaps, tried, dup, place, status, setup }: { d: Draft; gaps: readonly Gap[]; tried: boolean; dup: boolean; place: string; status: string; setup: boolean }) {
  if (dup)
    return (
      <>
        <b>{t("register.foot.dup")}</b>
      </>
    );
  if (tried && gaps.length > 0)
    return (
      <>
        <b role="alert" className={s.err}>{t("register.foot.errors", { n: gaps.length, list: names(gaps) })}</b>
        <span className={s.hint}>{t("register.foot.errorsHint", { first: t(`register.field.${gaps[0]!}`) })}</span>
      </>
    );
  const todo = gaps.filter((g) => REQUIRED.includes(g));
  if (gaps.length > 0)
    return (
      <>
        <b>{t("register.foot.todo", { n: todo.length, list: names(todo) })}</b>
      </>
    );
  return (
    <>
      <b>{t("register.foot.ready", { name: d.name.trim(), place: place || t("register.where.none"), status, date: d.hire.slice(5), number: d.numberMode === "manual" ? d.number.trim() : t("register.foot.numberAuto") })}</b>
      <span className={s.hint}>{t(setup ? "register.foot.readyHint" : "register.foot.readyHintOp")}</span>
    </>
  );
}
