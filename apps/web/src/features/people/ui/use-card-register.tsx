import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { registerGaps, registerItems, type RegisterItem } from "../domain/card";
import type { Card } from "./use-card";
import s from "./card.module.css";

/** The nine register items of one person and what each holds, as words (masked items say only "present, masked"). */
export function useCardRegister(c: Card) {
  const { e, d } = c;
  const r = c.register.data;
  const careers = r?.careers ?? null;
  const edu = (c.records.data?.items ?? []).filter((x) => x.section === "EDUCATION" && !x.voided).length;
  const items = registerItems({
    name: e.name,
    sex: r?.sex,
    birth: c.facts.data?.birth_date,
    address: r?.address,
    careers,
    job: e.job,
    hireDate: e.hire_date,
    exited: e.status === "EXITED",
    exitReason: r?.exit_reason_code,
  });
  const gaps = registerGaps(items);
  const value = (i: RegisterItem) => {
    if (!i.present) return <span className={s.gap}>{t("empCard.reg.gap")}</span>;
    switch (i.key) {
      case "name": return e.name;
      case "sex": return r?.sex ? t(`empCard.sex.${r.sex}`) : "";
      case "birth": case "address": return t("empCard.reg.masked");
      case "history": return t("empCard.reg.history", { careers: careers?.length ?? 0, edu });
      case "job": return e.job ?? "";
      case "contract": return t("empCard.reg.contract", { date: fmtDate(e.hire_date), end: d.employment?.contract_end_date ? `~ ${fmtDate(d.employment.contract_end_date)}` : t("empCard.reg.noEnd") });
      case "exit": return e.status === "EXITED" ? r?.exit_reason_label ?? "" : t("empCard.reg.na");
      case "note": return r?.register_note ? t("empCard.reg.note") : t("empCard.reg.noNote");
    }
  };
  return { items, gaps, value };
}
