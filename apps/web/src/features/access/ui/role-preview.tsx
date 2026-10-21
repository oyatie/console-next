import { t } from "@console/i18n";
import { effective, liveLevels, sellable, type Chosen, type Level, type Routed } from "../domain/grid";
import type { AccessCatalogDomain } from "../api";
import { domainHelp, domainText } from "../present";
import s from "./access.module.css";

/** Each level as a verb ("view and edit"), joined so the sentence ends on the last one. */
/** Domains about the tenant itself, not about the people in a scope (governance-31). */
const TENANT_LEVEL = new Set(["access", "audit", "settings", "retention", "tenant"]);
const verbs = (levels: readonly Level[]) => levels.map((l, i) => t(i === levels.length - 1 ? `accessCodes.verb.${l}` : `accessCodes.verb.${l}.and`)).join(" ");

/**
 * "people with this role" (mockup M2): what the grid allows in plain words, then what it does not, so a reader who never
 * opens the grid still knows the role. Built from the same grid the save sends.
 */
export function RolePreview({ domains, grid, routed }: { domains: readonly AccessCatalogDomain[]; grid: Chosen; routed: Routed }) {
  const offered = domains.filter((d) => sellable(d, routed));
  const can = offered.filter((d) => grid[d.domain]?.length);
  const cannot = offered.filter((d) => !grid[d.domain]?.length);
  // Only where an export exists today (governance-04): the rest never had one to miss.
  const noExport = can.filter((d) => liveLevels(d, routed).includes("export") && !effective(grid[d.domain]!).includes("export"));
  return (
    <>
      <h3>{t("access.preview.can")}</h3>
      {can.length ? (
        <ul>
          {can.map((d) => (
            <li key={d.domain}>
              {t(TENANT_LEVEL.has(d.domain) ? "access.preview.line.tenant" : "access.preview.line", { domain: domainText(d.domain), help: domainHelp(d.domain), verbs: verbs(effective(grid[d.domain]!)) })}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t("access.preview.nothing")}</p>
      )}
      <h3>{t("access.preview.cannot")}</h3>
      <ul className={s.lede}>
        {cannot.length > 0 && <li>{cannot.map((d) => domainText(d.domain)).join(", ")}</li>}
        {noExport.length > 0 && <li>{t("access.preview.noExport", { domains: noExport.map((d) => domainText(d.domain)).join(", ") })}</li>}
        {grid.hr_basic?.includes("edit") && <li>{t("accessGrants.scoped.note")}</li>}
        <li>{t("access.preview.outside")}</li>
        <li>{t("access.preview.self")}</li>
      </ul>
    </>
  );
}
