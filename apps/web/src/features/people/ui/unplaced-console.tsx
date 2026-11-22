// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { Band } from "../../../ui/band/band";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { PhaseLine } from "../../../ui/page-head/phase-line";
import { PageHeadingLevel, PageScope } from "../../../ui/page/page-scope";
import { WorklistPadded } from "../../../ui/patterns/worklist-parts";
import { SelectField } from "../../../ui/select/select-field";
import { useScreenStatusBar } from "../../../ui/status-bar/status-bar-store";
import { CompanyMappings } from "./company-mappings";
import { UnplacedFeedback, UnplacedPanes, UnplacedTabsRow } from "./unplaced-panes";
import { useUnplacedWorkspace } from "./use-unplaced-workspace";
import s from "./unplaced-console.module.css";

export function UnplacedConsole() {
  const ws = useUnplacedWorkspace();
  const { queue, pageRead, setup, all, placedCount, parts } = ws;

  useScreenStatusBar(
    queue.isSuccess
      ? [
          { id: "left", content: t("unplaced.sum", { left: queue.data.count, parts, done: placedCount }), tone: queue.data.count > 0 ? "attention" : "default" },
          { id: "reasons", content: t("unplaced.reasons", { workplaces: all.filter((p) => p.reason !== "unit_unknown").length, departments: all.filter((p) => p.reason === "unit_unknown").length }) },
        ]
      : undefined,
  );

  return (
    <PageScope value={{ landmark: true, embedded: false }}>
      <div className={s.page} data-floorplan="P-03">
        <Band>
          <PageHeadingLevel value={1}>
            <PageHead
              band
              crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} current={t("unplaced.crumbTodo")} />}
              title={t("unplaced.title")}
              meta={<PhaseLine phase={setup ? "setup" : "operating"}>{t(setup ? "unplaced.phaseSetup" : "unplaced.phaseOp")}</PhaseLine>}
              tools={<span className={s.sum} aria-busy={queue.isPending}>{queue.isSuccess ? t("unplaced.sum", { left: queue.data.count, parts, done: placedCount }) : "—"}</span>}
              actions={<Link to="/people" search={{}} className={buttonClass("ghost")}>{t("unplaced.back")}</Link>}
            />
          </PageHeadingLevel>
        </Band>
        <QueryState q={pageRead} layout="list">
          {() => (
            <>
              <Band>
                <WorklistPadded>
                  <UnplacedTabsRow ws={ws} tabsClassName={s.tabs} countClassName={s.count} />
                </WorklistPadded>
              </Band>
              <UnplacedPanes
                ws={ws}
                panesClassName={s.panes}
                consoleMode
                footer={
                  <div className={s.mappings}>
                    <UnplacedFeedback ws={ws} consoleMode />
                    <CompanyMappings
                      consoleMode
                      wrapSection={(children) => <Card titleId="unplaced-mappings" title={t("setup.names.title")} flush look="flush" topRule>{children}</Card>}
                      renderSingle={(p) => (
                        <SelectField
                          label={p.label}
                          required={p.required}
                          options={p.options.map((o) => ({ id: o.value, label: o.label, description: o.description }))}
                          value={p.value}
                          onChange={p.onChange}
                          placeholder={p.group}
                          error={p.error}
                        />
                      )}
                    />
                  </div>
                }
              />
            </>
          )}
        </QueryState>
      </div>
    </PageScope>
  );
}
