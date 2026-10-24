import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { GoLiveItem } from "@console/api/pending";
import { t } from "@console/i18n";
import { codeText } from "../../../lib/labels";
import { BlockedPanel } from "../../../ui/blocker/blocked-panel";
import { buttonClass } from "../../../ui/button/button-class";
import { SectionHead } from "../../../ui/card/section-head";
import { Chip } from "../../../ui/chip";
import { LongTable } from "../../../ui/long-table/long-table";
import { signedInName } from "../api";
import { recordFix, type GoLiveRecord } from "../domain/rail";
import { AcceptTerms } from "./terms";
import { AddPasskey } from "./add-passkey";
import { KeyValue } from "../../../ui/key-value/key-value";
import { FixLink } from "./fix-link";
import s from "./go-live.module.css";

const itemText = (x: GoLiveItem) => codeText(`setup.golive.item.${x.code}`, x.code, { count: x.count ?? 0 });

/** The fix of each record a line counts, opened on that record (company-53), e.g. attach a registration for one named workplace. */
function RecordFixes({ x }: { x: GoLiveItem }) {
  const fix = codeText(`setup.fix.${x.remedy}`, t("setup.fix.open"));
  if (x.remedy === "place_people") return <>
    <FixLink code={x.remedy} />
    <LongTable label={itemText(x)} rows={x.records as GoLiveRecord[]} rowId={(r) => r.id} total={x.records.length}
      hasMore={false} onLoadMore={() => undefined} empty={t("setup.golive.details.none")}
      columns={[{ id: "person", header: t("setup.golive.details.person"), rowHeader: true, cell: (r) =>
        r.kind === "employee" ? <Link to="/people/$id" params={{ id: r.id }} className={buttonClass("ghost")}>{r.name}</Link> : r.name }]} />
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
 * What still blocks go-live, one BlockedPanel each: what, its code, who can clear it (the person signed in) and the fix for
 * each record it counts. A blocker cleared on this screen (the terms) stays listed as resolved, at the height its panel
 * had, so the preview's re-read never pulls what is below it up under a pointer.
 */
export function Blockers({ items, changed = [] }: { items: GoLiveItem[]; changed?: string[] }) {
  const [seen, setSeen] = useState(items);
  const boxes = useRef(new Map<string, HTMLDivElement>());
  const heights = useRef(new Map<string, number>());
  const open = new Set(items.map((x) => x.code));
  // Before paint: an open panel's height is kept; a resolved row's box holds it.
  useLayoutEffect(() => {
    const measure = () => {
      for (const [code, el] of boxes.current) {
        if (open.has(code)) heights.current.set(code, el.offsetHeight);
        else el.style.minHeight = `${heights.current.get(code) ?? 0}px`;
      }
    };
    measure();
    // A lazy child read can grow a panel without rendering this parent.
    const observer = new ResizeObserver(measure);
    for (const [code, el] of boxes.current) if (open.has(code)) observer.observe(el);
    return () => observer.disconnect();
  });
  const fresh = items.filter((x) => !seen.some((y) => y.code === x.code));
  if (fresh.length > 0) setSeen([...seen, ...fresh]);
  if (seen.length === 0) return null;
  const you = { name: signedInName() ?? t("setup.golive.you"), role: t("setup.golive.youRole") };
  const box = (code: string) => (el: HTMLDivElement | null) => void (el ? boxes.current.set(code, el) : boxes.current.delete(code));
  return (
    <section aria-labelledby="blockers">
      <SectionHead level={2} id="blockers">{t("setup.golive.blockers")}</SectionHead>
      {seen.map((x) => (
        <div key={x.code} ref={box(x.code)} data-changed={changed.includes(x.code) || undefined}>
          {changed.includes(x.code) && <Chip tone="warn">{t("setup.golive.changed")}</Chip>}
          {open.has(x.code) ? (
            <BlockedPanel title={itemText(items.find((y) => y.code === x.code)!)} code={x.code} unblockers={[you]} actions={<Fixes x={items.find((y) => y.code === x.code)!} />} />
          ) : (
            <div className={`${s.resolved} row`}>
              <strong>{itemText(x)}</strong>
              <Chip tone="ok">{t("setup.golive.resolved")}</Chip>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

/** What to look at before starting (it does not block), each with the fix for each record it counts. */
export function Warnings({ items, changed = [] }: { items: GoLiveItem[]; changed?: string[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="warnings">
      <SectionHead level={2} id="warnings">{t("setup.golive.warnings")}</SectionHead>
      <KeyValue items={items.map((x) => ({ key: x.code, label: <>{changed.includes(x.code) && <Chip tone="warn">{t("setup.golive.changed")}</Chip>} {itemText(x)}</>, value: <Fixes x={x} /> }))} />
    </section>
  );
}
