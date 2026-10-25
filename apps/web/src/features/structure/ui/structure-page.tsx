import type { OrgStructure } from "@console/api/pending";
import { useState, type ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { todayKst } from "../../../lib/pure/today";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { EmptyState } from "../../../ui/empty-state";
import { ChartView } from "./chart-view";
import { FirstRun } from "./first-run";
import { OutlineView } from "./outline-view";
import { PageHead } from "./page-head";
import { CompareResults } from "./compare-control";
import { RegistryView } from "./registry-view";
import { SetupPanel } from "./setup-panel";
import { ChartSkeleton } from "./chart-skeleton";
import { useStructure } from "./use-structure";
import { useStructureCommands } from "./use-structure-commands";
import css from "./chart.module.css";

const route = getRouteApi("/app/org");
/** The acts that open a proposal card (the governed path a link may name); the structure sheets take the rest. */
const PROPOSAL_ACTS: readonly string[] = ["create", "rename", "move", "dissolve", "reassign"];

/**
 * company structure (spec S1): one page, three views of the same tree and the same selection (org chart · list · outline), the
 * phase stated in the head, and the setup panel beside it while setting up. An empty tenant shows the first run
 * (S10) in the chart's place. One selected box opens its side panel (S5 workplace, S6 department) and its acts open the structure
 * sheets over the page; a proposal card a link names (`?act=create` …) opens in the panel slot instead.
 */
export function StructurePage({ fixLink, proposal, panel, sheets }: {
  /** Where a setup remedy is fixed (the onboarding slice's links). */
  fixLink: (code: string) => ReactNode;
  /** The proposal card for `?act=` (the org slice). */
  proposal: ReactNode;
  /** The side panel of the one selected box (the org and entity slices). */
  panel: (sel: string, snapshot: OrgStructure, readOnly: boolean) => ReactNode;
  /** The sheets a panel's acts open (`?act=`), over the page. */
  sheets: ReactNode;
}) {
  const search = route.useSearch();
  const { view = "chart", focus, act, sel: picked } = search;
  const navigate = route.useNavigate();
  const { s, tree, diff } = useStructure(search);
  const cmd = useStructureCommands(!s || s.readOnly);
  // A place picked elsewhere (⌘K, a link) arrives as `sel` and becomes the selection; a pick from outside the chart
  // re-centres it. The values this page writes itself (one box chosen on the chart) arrive the same way, a frame or two
  // later and possibly between two clicks, so each is recognised and passed over: a Shift-click is never undone by the
  // URL catching up with the click before it.
  const [sel, setSel] = useState<ReadonlySet<string>>(() => new Set(picked ? [picked] : []));
  // A pick from outside (⌘K, a link, a sheet that lands on a unit) is brought into view on the chart in place.
  const [jump, setJump] = useState<{ id: string; n: number }>();
  // `arrived`: the URL value last seen; `own`: values written here and not yet seen; `last`: the latest one written or seen.
  const [url, setUrl] = useState<{ arrived?: string; own: readonly (string | undefined)[]; last?: string }>({ arrived: picked, own: [], last: picked });
  if (picked !== url.arrived) {
    const mine = url.own.indexOf(picked);
    // The latest write has landed (every earlier one is behind it), or an earlier one passes on its way.
    if (picked === url.last) setUrl({ arrived: picked, own: [], last: picked });
    else if (mine >= 0) setUrl({ ...url, arrived: picked, own: url.own.filter((_, i) => i !== mine) });
    else {
      setUrl({ arrived: picked, own: [], last: picked });
      setSel(new Set(picked ? [picked] : []));
      if (picked) setJump((j) => ({ id: picked, n: (j?.n ?? 0) + 1 }));
    }
  }
  // One box selected is written to the URL (`sel`), so its panel and the sheets its acts open find it; more than one
  // keeps the selection here only, and so does one gathered with Shift or Ctrl (`gather`: the start of several, so no
  // side panel opens and narrows the chart under the next click).
  const select = (next: ReadonlySet<string>, gather = false) => {
    setSel(next);
    const one = next.size === 1 && !gather ? [...next][0] : undefined;
    if (one === url.last) return;
    setUrl({ ...url, own: [...url.own, one], last: one });
    // The panel opening beside the chart relays the boxes; a box moved in the page drops focus, so it is put back
    // on the box that had it (its keys, A · M · F2 · Del, keep working).
    const had = document.activeElement?.getAttribute("role") === "treeitem" ? document.activeElement.id : undefined;
    void navigate({ search: (q) => ({ ...q, sel: one, act: undefined }), replace: true }).then(() =>
      requestAnimationFrame(() => {
        if (had && document.activeElement === document.body) document.getElementById(had)?.focus({ preventScroll: true });
      }),
    );
  };
  const proposing = Boolean(act && PROPOSAL_ACTS.includes(act) && (!s?.readOnly || (act === "create" && s?.asOf && s.asOf > todayKst() && !s.knownAt && !diff)));
  // Reserve the selected panel in the click's render, before its URL write arrives and moves the chart controls.
  const paneled = Boolean(url.last && sel.size === 1 && view === "chart" && ["site", "dept"].includes(s?.byId.get(url.last)?.kind ?? ""));
  const onFocus = (id: string | undefined) => void navigate({ search: (q) => ({ ...q, focus: id }) });
  const empty = s && s.root.children.length === 0;
  return (
    <div className={`page ${css.page}`}>
      <PageHead s={s} view={view} cmd={cmd} />
      <QueryState q={tree} loading={<ChartSkeleton />}>{() => <>
      <div className={css.body}>
          {
              !s ? null
              : empty ? (s.readOnly ? <EmptyState title={t("asof.noRecords")} reason={null} /> : <FirstRun />)
              : view === "list" ? <RegistryView s={s} cmd={cmd} sel={sel} onSelect={select} />
              : view === "outline" ? <OutlineView s={s} cmd={cmd} sel={sel} onSelect={select} />
              : <ChartView key={focus ?? "tenant"} pick={jump} dimmed={!!tree.error} s={s} cmd={cmd} focusId={focus} onFocus={onFocus} sel={sel} onSelect={select} />
            }

        {/* The setup panel belongs to the home view (S1); a focused chart (S2) takes the full width. */}
        {proposing ? <aside className={css.side} aria-label={t("structure.side")}>{proposal}</aside>
          : paneled && tree.data ? <div className={css.side}>{panel(url.last!, tree.data, cmd.readOnly)}</div>
          : s?.phase === "SETUP" && !s.readOnly && view === "chart" && !focus && <SetupPanel s={s} first={empty} fixLink={fixLink} />}
      </div>
      {!cmd.readOnly && sheets}
    {/* Late comparison records follow the full-height chart so they cannot shrink its canvas. */}
    {diff && <CompareResults result={diff} />}
    </>}</QueryState>
    </div>
  );
}
