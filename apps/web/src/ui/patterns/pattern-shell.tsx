// SPDX-License-Identifier: LicenseRef-Proprietary
import { useContext, useState, type ReactNode } from "react";
import { useActiveExperienceId } from "../../experience/dom";
import type { ReadBack } from "../../lib/react/denied";
import { QueryState } from "../../lib/react/query-state";
import { queryView, type ReadState } from "../../lib/react/query-view";
import { PageReadGate } from "../../reference/authz/ui/access-gate";
import { Band } from "../band/band";
import { Button } from "../button/button-base";
import type { MenuAction } from "../menu/action-menu";
import { PageHead, type PageHeadProps } from "../page-head/page-head";
import { PageHeadActions } from "../page-head/page-head-actions";
import type { Floorplan } from "../page/floorplan";
import { PageHeadingLevel, PagePhoneHeader, PageScope } from "../page/page-scope";
import { shown } from "../shown";
import type { ReadLayout } from "../skeleton/skeleton";
import { useScreenStatusBar } from "../status-bar/status-bar-store";
import type { PatternId } from "./patterns";
import s from "./pattern-shell.module.css";

/** Shared page-head slot contract used across Page Patterns `P3`–`P7` and `P12`–`P13`. */
export type PatternHead = Pick<
  PageHeadProps,
  "title" | "titleId" | "crumbs" | "meta" | "filters" | "tools" | "asOf" | "actions" | "tabs"
> & {
  primary?: MenuAction & { disabled?: boolean; icon?: ReactNode };
  commands?: { label: string; items: readonly MenuAction[] };
};

/** Shared base fields inherited by every pattern contract in `P3`–`P7`, `P12`–`P13`. */
export type PatternBaseProps = {
  /** Primary read state governing `PageReadGate` refusal and `QueryState` loading/error recovery. */
  q: ReadState;
  /** Command-strip or header specification (`title`, optional `crumbs`/`meta`/`filters`/`tools`/`actions`). */
  head: PatternHead;
  /** Optional view/route tabs placed above `PageReadGate` so navigation remains reachable on `403` refusal. */
  tabs?: ReactNode;
  /** Optional transient notices or command receipts inside `QueryState`. */
  notes?: ReactNode;
  /** Optional trailing footer region beneath the primary body. */
  foot?: ReactNode;
  /** Optional redundant summary facts omitted by this arrangement (`*OptionalRegions`). */
  facts?: ReactNode;
  /** Sheets or dialogs mounted inside `PageReadGate` and outside `QueryState`. */
  overlays?: ReactNode;
  /** Status-bar segments published while mounted in an experience with a status bar. */
  statusSegments?: Parameters<typeof useScreenStatusBar>[0];
  /** Preserve already-loaded record content behind an `inert` banner if a background refetch returns 403/404. */
  keepOnLoss?: boolean;
  /** Optional return link rendered on initial 403/404 refusal or missing-record empty states. */
  back?: ReadBack;
  /** Optional error-code copy resolver forwarded to `PageReadGate` and `QueryState`. */
  own?: (code: string) => string | undefined;
  /** Optional explanation rendered when the record has been deleted (`404`). */
  removed?: string;
  /** Temporary Classic (`baseline`) fallback renderer kept until Phase 7. */
  baseline?: () => ReactNode;
};

/**
 * Shared frame orchestrating `PageScope`, `PageHeadingLevel`, `PagePhoneHeader`, `PageReadGate`, `QueryState`,
 * `data-detail` gating via `queryView(q)`, `useScreenStatusBar`, and `baseline` fallback across `P3`–`P7`, `P12`–`P13`.
 */
export function PatternShell({
  pattern,
  floorplan,
  q,
  head,
  tabs,
  toolbar,
  overlays,
  queryLayout,
  detailActive = false,
  phoneHeadAware = false,
  statusSegments,
  keepOnLoss,
  back,
  own,
  removed,
  baseline,
  children,
}: {
  pattern: PatternId;
  floorplan: Floorplan;
  q: ReadState;
  head: PatternHead;
  tabs?: ReactNode;
  /** A strip under the head that waits for the first answer, then stays through a failed read and the reads after it
   * (its controls may be the way out, such as an as-of date). A refusal removes it with the rest of the page. */
  toolbar?: ReactNode;
  overlays?: ReactNode;
  queryLayout: ReadLayout;
  detailActive?: boolean;
  phoneHeadAware?: boolean;
  statusSegments?: Parameters<typeof useScreenStatusBar>[0];
  keepOnLoss?: boolean;
  back?: ReadBack;
  own?: (code: string) => string | undefined;
  removed?: string;
  baseline?: () => ReactNode;
  children: () => ReactNode;
}) {
  const experience = useActiveExperienceId();
  const useBaselineFallback = Boolean(baseline && experience === "baseline");
  useScreenStatusBar(useBaselineFallback ? null : statusSegments);
  const scope = useContext(PageScope);
  const level = useContext(PageHeadingLevel);
  const { shellOwnsH1 } = useContext(PagePhoneHeader);
  const view = queryView(q);
  const [latchedRefusal, setLatchedRefusal] = useState<unknown>(null);
  const refused = view === "denied" || view === "not-found";
  if (refused && latchedRefusal !== q.error) setLatchedRefusal(q.error);
  if (view === "ready" && !q.isPlaceholderData && latchedRefusal) setLatchedRefusal(null);
  // A read started after a failure is "loading" again; the toolbar that started it (and its focus) stays.
  const [answered, setAnswered] = useState(false);
  if (view !== "loading" && !answered) setAnswered(true);

  if (useBaselineFallback && baseline) return <>{baseline()}</>;

  const secondary = scope.embedded || level === 2;
  const Root = scope.landmark || secondary ? "div" : "main";
  const lost = Boolean(keepOnLoss && q.data !== undefined && refused && !(q.isPlaceholderData && latchedRefusal));
  const gateRefused = refused || Boolean(q.isPlaceholderData && latchedRefusal);
  const showDetail =
    detailActive && (!gateRefused || lost) && Boolean(q.data) && (view === "ready" || view === "stale" || view === "offline" || lost);

  return (
    <PageScope value={{ landmark: true, embedded: true }}>
      <Root
        className={`${s.frame}${secondary ? "" : ` ${s.standalone}`}`}
        data-pattern={pattern}
        data-floorplan={floorplan}
        data-detail={showDetail || undefined}
      >
        {tabs}
        <PageReadGate
          q={q}
          keepOnLoss={keepOnLoss}
          back={back}
          own={own}
          removed={removed}
          head={available => {
            const hasExtra =
              available &&
              Boolean(
                head.crumbs ||
                  head.meta ||
                  head.filters ||
                  head.tools ||
                  head.asOf ||
                  head.primary ||
                  head.actions ||
                  head.commands,
              );
            if (phoneHeadAware && shellOwnsH1 && !hasExtra) return null;
            if (!available && secondary) return null;
            const headingLevel = phoneHeadAware && shellOwnsH1 ? 2 : secondary ? 2 : 1;
            return (
              <Band className={s.head}>
                <PageHeadingLevel value={headingLevel}>
                  <PageHead
                    band
                    title={head.title}
                    titleId={head.titleId}
                    crumbs={available ? head.crumbs : undefined}
                    meta={available ? head.meta : undefined}
                    asOf={available ? head.asOf : undefined}
                    filters={available && shown(head.filters) ? <div className={s.inlineFilters}>{head.filters}</div> : undefined}
                    tools={available && shown(head.tools) ? head.tools : undefined}
                    primary={
                      available &&
                      head.primary && (
                        <Button variant="primary" disabled={head.primary.disabled} onClick={head.primary.onAction}>
                          {head.primary.icon}
                          {head.primary.label}
                        </Button>
                      )
                    }
                    actions={
                      available && (head.actions || head.commands) ? (
                        <>
                          {head.actions}
                          {head.commands && <PageHeadActions {...head.commands} />}
                        </>
                      ) : undefined
                    }
                    tabs={available ? head.tabs : undefined}
                  />
                </PageHeadingLevel>
              </Band>
            );
          }}
        >
          {overlays}
          {answered ? toolbar : null}
          <PageHeadingLevel value={2}>
            <QueryState q={q} layout={queryLayout} keepOnLoss={keepOnLoss} back={back} own={own} removed={removed}>
              {children}
            </QueryState>
          </PageHeadingLevel>
        </PageReadGate>
      </Root>
    </PageScope>
  );
}

/** Branches a route or feature screen on the active experience without letting feature modules import `experience/dom`. */
export function ExperienceSwitch({ baseline, children }: { baseline: () => ReactNode; children: () => ReactNode }) {
  const experience = useActiveExperienceId();
  return <>{experience === "baseline" ? baseline() : children()}</>;
}
