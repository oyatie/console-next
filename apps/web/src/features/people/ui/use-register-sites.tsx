import { useQueries, useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { entitiesRef } from "../../../reference/entity/api";
import { factsQuery } from "../api";
import { registerFactsQuery, workplaceCountsQuery } from "../api/record";
import { maskedAddress } from "../domain/card";
import s from "./card.module.css";
import { entityName } from "../../../reference/entity/domain/names";

const WORKERS = ["ACTIVE", "ON_LEAVE"] as const;

/** Every workplace by its company, and how many people each register holds: workers (active and on leave) and the exited. */
export function useSites() {
  const entities = useQuery(entitiesRef).data?.items ?? [];
  const workers = useQuery(workplaceCountsQuery(undefined, [...WORKERS])).data?.workplace;
  const exited = useQuery(workplaceCountsQuery(undefined, ["EXITED"])).data?.workplace;
  const n = (rows: typeof workers, id: string) => (rows ? (rows.find((x) => x.value === id)?.count ?? 0) : undefined);
  return entities.map((e) => ({
    id: e.id,
    name: entityName(e),
    sites: e.workplaces.map((w) => ({ id: w.id, entity: entityName(e), name: w.current?.name ?? "", workers: n(workers, w.id), exited: n(exited, w.id) })),
  }));
}
export type Site = ReturnType<typeof useSites>[number]["sites"][number];

/** What the preview's first rows hold for sex, birth date, address, history, masked as the paper is until a privacy mode lets more out. */
export function usePreviewFacts(ids: readonly string[]) {
  const reg = useQueries({ queries: ids.map((id) => ({ ...registerFactsQuery(id), retry: false })) });
  const facts = useQueries({ queries: ids.map((id) => ({ ...factsQuery(id), retry: false })) });
  return (id: string) => {
    const at = ids.indexOf(id);
    const r = reg[at]?.data;
    const birth = facts[at]?.data?.birth_date;
    const careers = r?.careers;
    return {
      sex: r?.sex ? t(`empCard.sex.${r.sex}`) : r ? <span className={s.gap}>{t("empDoc.reg.blank")}</span> : "…",
      birth: birth ? t("empDoc.reg.birthMasked", { year: birth.slice(0, 4) }) : facts[at]?.data ? <span className={s.gap}>{t("empDoc.reg.blank")}</span> : "…",
      address: r?.address ? maskedAddress(r.address) : r ? <span className={s.gap}>{t("empDoc.reg.blank")}</span> : "…",
      history: careers == null ? (r ? <span className={s.gap}>{t("empDoc.reg.blank")}</span> : "…") : careers.length ? careers.map((c) => c.employer_name).join(" · ") : t("empDoc.reg.noCareer"),
    };
  };
}
