import { t } from "@console/i18n";
import { Check } from "../../../ui/button/button";
import { Table } from "../../../ui/table";
import { approveWord, autoView, effective, liveColumns, liveLevels, sellable, toggle, type Chosen, type Level, type Routed } from "../domain/grid";
import type { AccessCatalogDomain } from "../api";
import { domainHelp, domainText, levelText } from "../present";
import s from "./access.module.css";

/**
 * access (mockup M2): one row per data domain a role can hold today, one toggle per level that does something there
 * (governance-17: a level with no operation, and a domain with no screen, is never sold). A level not offered is absent, not disabled. Choosing create & edit, approve or export lights view as "included"; pressing that cell
 * clears the row.
 */
export function PermissionGrid({ domains, value, routed, onChange }: { domains: readonly AccessCatalogDomain[]; value: Chosen; routed: Routed; onChange: (next: Chosen) => void }) {
  // #26 (governance-03): each cell names its domain's decision (exit confirm, exception decide), an approval only on a routed row.
  const word = (d: AccessCatalogDomain, l: Level) => (l === "approve" ? t(`access.grid.approve.${approveWord(d.domain, routed)}`) : levelText(l));
  const cell = (d: AccessCatalogDomain, l: Level) => {
    if (!liveLevels(d, routed).includes(l)) return null;
    const chosen = value[d.domain] ?? [];
    const on = effective(chosen).includes(l);
    const auto = l === "view" && autoView(chosen);
    return (
      <Check
        checked={on}
        aria-label={t(auto ? "access.grid.cell.auto" : "access.grid.cell", { domain: domainText(d.domain), level: word(d, l) })}
        onChange={() => onChange(toggle(value, d.domain, l))}
      >
        {auto ? <span className={s.nowrap}>{t("access.grid.auto")}</span> : null}
      </Check>
    );
  };
  return (
    <Table
      label={t("access.grid.label")}
      rows={domains.filter((d) => sellable(d, routed))}
      rowId={(d) => d.domain}
      columns={[
        { header: t("access.grid.domain"), cell: (d) => <><strong>{domainText(d.domain)}</strong><small className={s.help}>{domainHelp(d.domain)}</small></> },
        ...liveColumns(domains, routed).map((l) => ({ header: levelText(l), fit: true, cell: (d: AccessCatalogDomain) => cell(d, l) })),
      ]}
    />
  );
}
