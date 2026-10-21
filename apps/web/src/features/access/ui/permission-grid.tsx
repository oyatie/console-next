import { Check } from "lucide-react";
import { t } from "@console/i18n";
import { ToggleButton } from "../../../ui/button/button";
import { Table } from "../../../ui/table";
import { approveWord, autoView, effective, liveColumns, liveLevels, sellable, toggle, type Chosen, type Level, type Routed } from "../domain/grid";
import type { AccessCatalogDomain } from "../api";
import { domainHelp, domainText, levelText } from "../present";
import s from "./access.module.css";

/**
 * access (mockup M2): one row per data domain a role can hold today, one toggle per level that does something there
 * (governance-17: a level with no operation, and a domain with no screen, is never sold; the latter are named once
 * below the grid as "not yet"). A level not offered is absent, not disabled. Choosing create & edit, approve or export lights view as "included"; pressing that cell
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
      <ToggleButton
        pressed={on}
        className={s.cell}
        data-auto={auto || undefined}
        aria-label={t(auto ? "access.grid.cell.auto" : "access.grid.cell", { domain: domainText(d.domain), level: word(d, l) })}
        onClick={() => onChange(toggle(value, d.domain, l))}
      >
        {on && <Check size={16} aria-hidden />}
        {/* A chosen cell is its check alone (mockup M2); the included view and an open cell say what they are. */}
        {(!on || auto) && <span>{auto ? t("access.grid.auto") : word(d, l)}</span>}
      </ToggleButton>
    );
  };
  const later = domains.filter((d) => d.grantable && !sellable(d, routed));
  return (
    <>
    <Table
      label={t("access.grid.label")}
      rows={domains.filter((d) => sellable(d, routed))}
      rowId={(d) => d.domain}
      columns={[
        { header: t("access.grid.domain"), cell: (d) => <><strong>{domainText(d.domain)}</strong><span className={s.help}>{domainHelp(d.domain)}</span></> },
        ...liveColumns(domains, routed).map((l) => ({ header: levelText(l), fit: true, cell: (d: AccessCatalogDomain) => cell(d, l) })),
      ]}
    />
    {later.length > 0 && <p className="muted">{t("access.grid.notYet", { domains: later.map((d) => domainText(d.domain)).join(", ") })}</p>}
    </>
  );
}
