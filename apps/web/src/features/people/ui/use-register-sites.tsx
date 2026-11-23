import { useQueries, useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { entitiesRef } from "../../../reference/entity/api";
import { REGISTER_FACTS_BATCH, registerFactsBatchQuery, workplaceCountsQuery, type RegisterFactsQueryItem } from "../api/record";
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
  const chunks = ids.length > 0
    ? Array.from({ length: Math.ceil(ids.length / REGISTER_FACTS_BATCH) }, (_, i) => ids.slice(i * REGISTER_FACTS_BATCH, (i + 1) * REGISTER_FACTS_BATCH))
    : [];
  const batch = useQueries({ queries: chunks.map((chunk) => ({ ...registerFactsBatchQuery(chunk), retry: false })) });
  const byId = new Map<string, RegisterFactsQueryItem>();
  for (const q of batch) {
    for (const item of q.data?.items ?? []) byId.set(item.employee_id, item);
  }
  return (id: string) => {
    const at = ids.indexOf(id);
    const loaded = at >= 0 && batch[Math.floor(at / REGISTER_FACTS_BATCH)]?.data !== undefined;
    const r = byId.get(id);
    const birth = r?.birth_date;
    const careers = r?.careers;
    return {
      sex: r?.sex ? t(`empCard.sex.${r.sex}`) : loaded ? <span className={s.gap}>{t("empDoc.reg.blank")}</span> : "…",
      birth: birth ? birth : loaded ? <span className={s.gap}>{t("empDoc.reg.blank")}</span> : "…",
      address: r?.address ? r.address : loaded ? <span className={s.gap}>{t("empDoc.reg.blank")}</span> : "…",
      history: careers == null ? (loaded ? <span className={s.gap}>{t("empDoc.reg.blank")}</span> : "…") : careers.length ? careers.map((c) => c.employer_name).join(" · ") : t("empDoc.reg.noCareer"),
    };
  };
}
