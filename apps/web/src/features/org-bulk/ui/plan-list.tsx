import { MapPin, Network } from "lucide-react";
import { t } from "@console/i18n";
import { Chip } from "../../../ui/chip";
import { EnumValue } from "../../../ui/enum-value";
import { ORG_BULK_PLAN_STATUS } from "../../../lib/labels";
import { TextInput } from "../../../ui/field/field";
import type { PlanRow } from "../domain/plan";
import s from "./bulk.module.css";

/**
 * The "what will be made" column (S7): each pasted line where it lands, with its status in text (D16) — linked to
 * what exists, new, or a line to fix. A clash is renamed in place; the plan redraws as the name changes.
 */
export function PlanList({ rows, names, onRename, rootName, levelOffset }: {
  rows: PlanRow[];
  /** 1 under a workplace root (its first line is the first department level), 0 under a legal entity. */
  levelOffset: number;
  names: Record<number, string>;
  onRename: (at: number, name: string) => void;
  rootName: string;
}) {
  const byAt = new Map(rows.map((r) => [r.at, r]));
  return (
    <>
      <ul className={s.plan} aria-label={t("orgBulk.plan.title")}>
        {rows.map((r) => {
          const Icon = r.level === "workplace" ? MapPin : Network;
          const status = r.status === "create" && r.level === "workplace" ? "createSite" : r.status;
          const fixing = r.status === "clash" || names[r.at] !== undefined;
          return (
            <li key={r.at} className={s.planRow} data-status={r.status} data-depth={Math.min(r.depth, 6)}>
              <Icon size={16} aria-hidden className="muted" />
              <span className={s.planName}>{r.name}</span>
              <EnumValue e={ORG_BULK_PLAN_STATUS} value={status} />
              {r.kind && r.level === "workplace" && <Chip>{t("orgBulk.plan.kind", { kind: r.kind })}</Chip>}
              {fixing && r.status !== "tooDeep" && (
                <TextInput
                  className={s.rename}
                  aria-label={t("orgBulk.plan.rename", { line: r.line })}
                  value={names[r.at] ?? r.name}
                  onChange={(e) => onRename(r.at, e.target.value)}
                />
              )}
              <span className={s.where}>
                {r.level === "workplace" ? t("orgBulk.plan.where.site") : r.parent === undefined || byAt.get(r.parent)?.level === "workplace" ? t("orgBulk.plan.where.top") : t("orgBulk.plan.where.deep", { depth: r.depth + levelOffset })}
              </span>
            </li>
          );
        })}
      </ul>
      {rows.filter((r) => r.status === "clash" || r.status === "tooDeep" || r.status === "kind_not_allowed").map((r) => (
        <p key={r.at} className={s.danger} role="alert">
          {r.status === "clash"
            ? t("orgBulk.plan.clash", { parent: r.parent === undefined ? rootName : byAt.get(r.parent)!.name, name: r.name, line: r.line })
            : r.status === "kind_not_allowed" ? t("orgBulk.paste.error.kind_not_allowed", { line: r.line }) : t("orgBulk.plan.tooDeep", { line: r.line })}
        </p>
      ))}
    </>
  );
}
