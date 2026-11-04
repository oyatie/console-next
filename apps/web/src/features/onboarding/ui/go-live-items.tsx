// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { GoLiveItem } from "@console/api/pending";
import { t } from "@console/i18n";
import { codeText } from "../../../lib/labels";
import { Banner } from "../../../ui/banner/banner";
import { BlockedPanel } from "../../../ui/blocker/blocked-panel";
import { buttonClass } from "../../../ui/button/button-class";
import { SectionHead } from "../../../ui/card/section-head";
import { Chip } from "../../../ui/chip";
import { LongTable } from "../../../ui/long-table/long-table";
import { KeyValue } from "../../../ui/key-value/key-value";
import { signedInName } from "../api";
import { recordFix, type GoLiveRecord } from "../domain/rail";
import { AcceptTerms } from "./terms";
import { AddPasskey } from "./add-passkey";
import { FixLink } from "./fix-link";
import s from "./go-live.module.css";

const itemText = (x: GoLiveItem) => codeText(`setup.golive.item.${x.code}`, x.code, { count: x.count ?? 0 });
const hasEmployeeRecords = (x: GoLiveItem) => x.records.length > 0 && x.records.every((r) => r.kind === "employee");

function EmployeeRecords({ x }: { x: GoLiveItem }) {
  return <LongTable label={itemText(x)} rows={x.records as GoLiveRecord[]} rowId={(r) => r.id} total={x.records.length}
    hasMore={false} onLoadMore={() => undefined} empty={t("setup.golive.details.none")}
    columns={[{ id: "person", header: t("setup.golive.details.person"), rowHeader: true, cell: (r) =>
      r.kind === "employee" ? <Link to="/people/$id" params={{ id: r.id }} className={buttonClass("ghost")}>{r.name}</Link> : r.name }]} />;
}

/** The fix of each record a line counts, opened on that record (company-53), e.g. attach a registration for one named workplace. */
function RecordFixes({ x }: { x: GoLiveItem }) {
  const fix = codeText(`setup.fix.${x.remedy}`, t("setup.fix.open"));
  if (hasEmployeeRecords(x)) return <>
    <FixLink code={x.remedy} />
    <EmployeeRecords x={x} />
  </>;
  return (
    <>
      {(x.records as GoLiveRecord[]).map((r) => {
        const target = recordFix(r, x.remedy ?? undefined);
        return target ? <Link key={r.id} {...target} className={buttonClass()}>{t("setup.golive.fixOf", { fix, name: r.name })}</Link> : <KeyValue key={r.id} items={[{ key: r.id, label: t("setup.golive.details.place"), value: r.name }]} />;
      })}
    </>
  );
}

/** What resolves a line: its records' own fixes, the terms or a passkey in place, else the screen where it is fixed. */
function Fixes({ x }: { x: GoLiveItem }) {
  if (x.remedy === "accept_terms") return <AcceptTerms />;
  if (x.remedy === "add_passkey") return <AddPasskey count={x.count ?? 0} />;
  if (x.records.length > 0) return <RecordFixes x={x} />;
  return <FixLink code={x.remedy} />;
}

/**
 * Compact blocker rows: what blocks go-live, its disclosed refusal code, owner, and direct remedy.
 * Blockers cleared in place collapse cleanly to a single resolved row without blank space.
 */
export function Blockers({ items, changed = [] }: { items: GoLiveItem[]; changed?: string[] }) {
  const [seen, setSeen] = useState(items);
  const fresh = items.filter((x) => !seen.some((y) => y.code === x.code));
  if (fresh.length > 0) setSeen([...seen, ...fresh]);
  if (seen.length === 0) return null;
  const owner = t("setup.owner", { owner: signedInName() ?? t("setup.golive.you") });
  return (
    <section aria-labelledby="blockers" className={s.stack}>
      <SectionHead level={2} id="blockers">{t("setup.golive.blockers")}</SectionHead>
      <div className={s.blockerList}>
        {seen.map((x) => {
          const current = items.find((y) => y.code === x.code);
          return (
            <div key={x.code} data-blocker-row={x.code} data-changed={changed.includes(x.code) || undefined}>
              {changed.includes(x.code) && <Chip tone="warn">{t("setup.golive.changed")}</Chip>}
              {current ? (
                <BlockedPanel
                  compact
                  domain="onboarding"
                  code={current.code}
                  title={itemText(current)}
                  owner={owner}
                  actions={hasEmployeeRecords(current) ? <FixLink code={current.remedy} /> : <Fixes x={current} />}
                >
                  {hasEmployeeRecords(current) ? <EmployeeRecords x={current} /> : undefined}
                </BlockedPanel>
              ) : (
                <Banner tone="ok" title={itemText(x)} actions={<Chip tone="ok">{t("setup.golive.resolved")}</Chip>} />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** What to look at before starting (it does not block), each with the fix for each record it counts. */
export function Warnings({ items, changed = [] }: { items: GoLiveItem[]; changed?: string[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="warnings" className={s.stack}>
      <SectionHead level={2} id="warnings">{t("setup.golive.warnings")}</SectionHead>
      <div className={s.blockerList}>
        {items.map((x) => (
          <Banner key={x.code} tone="warn" title={<>{changed.includes(x.code) && <Chip tone="warn">{t("setup.golive.changed")}</Chip>}{itemText(x)}</>} actions={<Fixes x={x} />} />
        ))}
      </div>
    </section>
  );
}
