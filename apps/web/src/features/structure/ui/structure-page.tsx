import { UnitEdit } from "../../../reference/org/ui/use-unit-edit";
import { useStructureEdit } from "./use-structure-gestures";
import { RegistryExportContext } from "./export-scope";
import type { ChartNode } from "../domain/model";
import type { OrgStructure } from "@console/api/pending";
import { useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { todayKst } from "../../../lib/pure/today";
import { t } from "@console/i18n";
import { focusSoon } from "../../../lib/react/announce";
import { QueryState } from "../../../lib/react/query-state";
import { freshOnOpen, get } from "../../../lib/query";
import { useNarrow } from "../../../ui/dock-sheet/use-narrow";
import { EmptyState } from "../../../ui/empty-state";
import { FlexibleColumns } from "../../../ui/flexible-columns/flexible-columns";
import { ChartView } from "./chart-view";
import { FirstRun } from "./first-run";
import { OutlineView } from "./outline-view";
import { PageHead, type ViewCommands } from "./page-head";
import { CompareResults } from "./compare-control";
import { RegistryView } from "./registry-view";
import { ChartSkeleton } from "./chart-skeleton";
import { useStructure } from "./use-structure";
import { useStructureCommands } from "./use-structure-commands";
import css from "./chart.module.css";

const route = getRouteApi("/app/org");
/** The acts that open a proposal card (the governed path a link may name); the structure sheets take the rest. */
const PROPOSAL_ACTS: readonly string[] = ["create", "rename", "move", "dissolve", "reassign"];

/**
 * company structure (spec S1): one page, three views of the same tree and the same selection (org chart · list · outline), the
 * phase stated in the head, one toolbar for all three. An empty tenant shows the first run (S10) in the chart's place.
 * One selected workplace or department opens its panel (S5, S6) as the column beside the view, in every view, and its
 * acts open the structure sheets over the page; a proposal card a link names (`?act=create` …) takes that column instead.
 * Below 960 px the chart keeps the panel under it, so a box and its tools stay on screen while it is selected.
 */
export function StructurePage({ proposal, panel, sheets }: {
  /** The proposal card for `?act=` (the org slice). */
  proposal: ReactNode;
  /** The side panel of the one selected box (the org and entity slices). */
  panel: (sel: string, snapshot: OrgStructure, readOnly: boolean) => ReactNode;
  /** The sheets a panel's acts open (`?act=`), over the page. */
  sheets: ReactNode;
}) {
  const search = route.useSearch();
  const [exportRows, setExportRows] = useState<readonly ChartNode[] | null>(null);
  const [find, setFind] = useState("");
  const commands = useRef<ViewCommands>(null);
  const narrow = useNarrow();
  const { view = "chart", focus, act, sel: picked } = search;
  const navigate = route.useNavigate();
  const { s, tree, ready, diff } = useStructure(search);
  const dates = freshOnOpen(useQuery({ ...get("/api/v1/org-structure/change-dates", { params: { query: { from: "0001-01-01", to: "9999-12-31", known_at: search.known_at } } }), refetchOnMount: "always" }));
  const pageRead = { ...ready, refetch: () => Promise.all([ready.refetch(), dates.refetch()]) };
  const cmd = useStructureCommands(!s || s.readOnly);
  const canEdit = useStructureEdit(s?.phase === "SETUP", cmd.readOnly);
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
  const one = url.last && sel.size === 1 ? s?.byId.get(url.last) : undefined;
  const paneled = one && (one.kind === "site" || one.kind === "dept") && tree.data ? one : undefined;
  const stacked = view === "chart" && narrow;
  const side = proposing ? { id: "proposal", label: t("structure.side"), onClose: () => void navigate({ search: (q) => ({ ...q, act: undefined }), replace: true }), children: proposal }
    : paneled && {
        id: paneled.id,
        label: paneled.name,
        onClose: () => select(new Set()),
        // The box or row the panel was opened from, in whichever view is shown.
        returnFocus: () => document.getElementById(`node-${paneled.id}`) ?? document.getElementById(`outline-${paneled.id}`) ?? document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(paneled.id)}"]`),
        children: panel(paneled.id, tree.data!, cmd.readOnly),
      };
  const onFocus = (id: string | undefined) => void navigate({ search: (q) => ({ ...q, focus: id }) });
  const empty = s && s.root.children.length === 0;
  return (
    <UnitEdit.Provider value={canEdit}>
    <RegistryExportContext.Provider value={view === "list" ? exportRows : null}>
    <div className={css.page}>
      <PageHead s={s} view={view} cmd={cmd} changeDates={dates.isSuccess ? dates.data?.items : undefined} loadingDates={dates.isFetching} readFailed={!!ready.error && !s} find={find} onFind={setFind} commands={commands} inline={canEdit} />
      {!ready.error && dates.isError && <QueryState q={dates} inline own={() => t("asof.error")}>{() => null}</QueryState>}
      <QueryState q={pageRead} loading={<ChartSkeleton />}>{() => <>
      <div className={css.body}>
        {/* No list-follow here: the tree moves its own cursor, and the list's checkboxes are a multi-selection that focus must not replace. */}
        <FlexibleColumns
          onFind={() => focusSoon("structure-find")}
          record={!stacked && side}
          list={<div className={css.view}>
            {
              !s ? null
              : empty ? (s.readOnly ? <EmptyState title={t("asof.noRecords")} reason={null} /> : <FirstRun />)
              : view === "list" ? <RegistryView ref={commands} find={find} s={s} cmd={cmd} sel={sel} onSelect={select} onVisibleRows={setExportRows} />
              : view === "outline" ? <OutlineView ref={commands} find={find} follow={!act} pick={jump} s={s} cmd={cmd} sel={sel} onSelect={select} />
              : <ChartView ref={commands} find={find} key={focus ?? "tenant"} pick={jump} covered={Boolean(act)} dimmed={!!ready.error} s={s} cmd={cmd} focusId={focus} onFocus={onFocus} sel={sel} onSelect={select} />
            }
            {stacked && side && (proposing ? <aside className={css.side} aria-label={side.label}>{side.children}</aside> : <div className={css.side}>{side.children}</div>)}
          </div>}
        />
      </div>
      {!cmd.readOnly && sheets}
    {/* Late comparison records follow the full-height chart so they cannot shrink its canvas. */}
    {diff && <CompareResults result={diff} />}
    </>}</QueryState>
    </div>
    </RegistryExportContext.Provider>
    </UnitEdit.Provider>
  );
}
