// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApiError } from "@console/api";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { tg } from "@console/i18n/gallery";
import { todayKst } from "../../lib/pure/today";
import { Button, ToggleButton } from "../../ui/button/button";
import { Count } from "../../ui/count/count";
import { EmptyState } from "../../ui/empty-state";
import { LongTable } from "../../ui/long-table/long-table";
import { AsOf } from "../../ui/page-head/as-of";
import { Crumbs } from "../../ui/page-head/crumbs";
import { PageHead } from "../../ui/page-head/page-head";
import { PageHeadActions } from "../../ui/page-head/page-head-actions";
import { PhaseLine } from "../../ui/page-head/phase-line";
import { Sheet } from "../../ui/sheet/sheet";
import { TabNav } from "../../ui/tabs/tabs";
import { tabClass } from "../../ui/tabs/tab-class";
import { Page } from "../../ui/page/page";
import { Section } from "../Section";

export const order = 128;
const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });

/** Synthetic reads exercise the frame without issuing requests from the gallery. */
export default function PageGallery() {
  return <QueryClientProvider client={client}><FrameDemo /></QueryClientProvider>;
}

function FrameDemo() {
  const [state, setState] = useState("populated");
  const [limit, setLimit] = useState(50);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const states = { loading: t("common.loading"), empty: tg("empty.title"), failed: t("common.loadFailed.title"), refused: t("common.denied.title.plain"), populated: tg("pageHead.populated"), long: tg("sample.longName"), large: fmtNumber(2000) };
  const rows = Array.from({ length: state === "empty" ? 0 : state === "large" ? 2000 : 3 }, (_, i) => ({ id: String(i), name: tg("sample.person", { n: i + 1 }) }));
  const q = {
    isPending: state === "loading",
    data: state === "loading" || state === "failed" ? undefined : rows,
    error: state === "failed" ? new ApiError(503, "service_unavailable", "", [], "gallery-page-read") : state === "refused" ? new ApiError(403, "access_denied", "", [], "gallery-page-refusal") : null,
    refetch: () => setState("populated"),
  };
  return <div data-page-gallery data-page-state={state}><Section title={tg("section.pageHead")}>
    <div className="row" role="group" aria-label={tg("section.states")}>
      {Object.entries(states).map(([id, label]) => <ToggleButton key={id} pressed={state === id} onClick={() => { setState(id); setLimit(50); }}>{label}</ToggleButton>)}
    </div>
    <Page floorplan="list" q={q} head={{
      title: state === "long" ? tg("sample.longName").repeat(4) : tg("pageHead.list"),
      titleId: "gallery-page-title",
      crumbs: <Crumbs items={[<Link key="root" to="/_gallery" hash="main">{tg("pageHead.crumbRoot")}</Link>]} current={tg("pageHead.list")} />,
      meta: <><PhaseLine phase="operating">{tg("pageHead.operating")}</PhaseLine><span><Count n={state === "loading" || state === "failed" ? undefined : rows.length} failed={state === "failed" ? t("common.loadFailed.title") : undefined} /></span></>,
      primary: <Button variant="primary" onClick={() => setOpen(true)}>{tg("pageHead.add")}</Button>,
      actions: <PageHeadActions label={t("uiRecordActions.more", { field: tg("pageHead.list") })} items={[{ id: "export", label: tg("pageHead.export"), onAction: () => setMessage(tg("pageHead.populated")) }]} />,
      asOf: <AsOf label={t("asof.label")} date={todayKst()} today={t("asof.today")} />,
      tabs: <TabNav label={tg("pageHead.list")}><Link to="/_gallery" hash="gallery-page-title" className={tabClass} aria-current="page">{tg("pageHead.facts")}</Link></TabNav>,
    }} empty={items => items.length ? null : <EmptyState title={tg("empty.title")} reason={tg("empty.reason")} />}>
      {items => <>
        <LongTable label={tg("pageHead.list")} columns={[{ id: "name", header: tg("pageHead.list"), rowHeader: true, card: "title", cell: row => row.name }]} rows={items.slice(0, limit)} rowId={row => row.id} empty={null} hasMore={items.length > limit} onLoadMore={() => setLimit(n => n + 50)} />
        <span role="status">{message}</span>
        <Sheet open={open} title={tg("sheet.title")} onClose={() => setOpen(false)} consequence={tg("sheet.consequence")} actions={<Button onClick={() => setOpen(false)}>{t("common.cancel")}</Button>}>
          <PageHead title={tg("sheet.subtitle")} />
          <Page floorplan="form" head={{ title: tg("sheet.reason") }}>{tg("sheet.reasonHint")}</Page>
        </Sheet>
      </>}
    </Page>
  </Section></div>;
}
