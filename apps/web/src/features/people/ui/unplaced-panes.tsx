// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import { entityNameText } from "../../../reference/entity/present";
import { EntityName } from "../../../reference/entity/ui/entity-name";
import { ToggleButton } from "../../../ui/button/button";
import { Receipt } from "../../../ui/receipt/receipt";
import { sourceText } from "../present";
import { UnplacedDone } from "./unplaced-done";
import { UnplacedGroups } from "./unplaced-groups";
import { UnplacedRefused } from "./unplaced-refused";
import { UnplacedRows } from "./unplaced-rows";
import { UnplacedTargets } from "./unplaced-targets";
import { UnplacedWhen } from "./unplaced-when";
import { UNPLACED_NONE, type useUnplacedWorkspace } from "./use-unplaced-workspace";

export function UnplacedTabsRow({
  ws,
  tabsClassName,
  countClassName,
}: {
  ws: ReturnType<typeof useUnplacedWorkspace>;
  tabsClassName?: string;
  countClassName?: string;
}) {
  return (
    <div role="group" aria-label={t("unplaced.tabs")} className={tabsClassName}>
      {ws.tabs.map((x) => (
        <ToggleButton key={x} pressed={x === ws.tab} onClick={() => ws.selectTab(x)}>
          {x === UNPLACED_NONE ? t("unplaced.noEntity") : <EntityName entity={ws.entities.find((e) => e.id === x)} />}
          <span className={countClassName}>{ws.all.filter((e) => (e.legal_entity_id ?? UNPLACED_NONE) === x).length}</span>
        </ToggleButton>
      ))}
    </div>
  );
}

export function UnplacedPanes({
  ws,
  panesClassName,
  consoleMode = false,
  footer,
}: {
  ws: ReturnType<typeof useUnplacedWorkspace>;
  panesClassName?: string;
  consoleMode?: boolean;
  footer: ReactNode;
}) {
  return (
    <>
      {ws.all.length === 0 ? (
        <UnplacedDone placed={ws.placedCount} />
      ) : (
        <div className={panesClassName}>
          <UnplacedGroups groups={ws.groups} done={ws.tabDone} current={ws.g} onPick={ws.pickGroup} hint={ws.groupHint} consoleMode={consoleMode} />
          <UnplacedRows group={ws.group} sel={ws.sel} onSel={ws.setSel} done={ws.tabDone} consoleMode={consoleMode} />
          <UnplacedTargets
            consoleMode={consoleMode}
            blockReason={consoleMode ? ws.blockReason : undefined}
            when={!ws.setup ? <UnplacedWhen today={ws.today} value={ws.date} onChange={ws.setDate} onInvalid={ws.setInvalidDate} /> : undefined}
            where={t("unplaced.target.where", { entity: ws.entity ? entityNameText(ws.entity) : t("unplaced.noEntity"), value: sourceText(ws.group?.value ?? "") })}
            count={ws.picked.length}
            suggestions={ws.suggestions}
            options={ws.targetOptions}
            sitePath={ws.pathOf}
            chosen={ws.chosen}
            onChoose={ws.setChosen}
            onPlace={ws.place}
            onSite={ws.site ? () => ws.place(ws.site!.unit.id) : null}
            onSkip={() => ws.move(1)}
            pending={Boolean(ws.blockReason) || ws.placer.isPending}
            entity={ws.entity ? entityNameText(ws.entity) : null}
            value={sourceText(ws.group?.value ?? "")}
          />
        </div>
      )}
      {footer}
    </>
  );
}

export function UnplacedFeedback({ ws, consoleMode = false }: { ws: ReturnType<typeof useUnplacedWorkspace>; consoleMode?: boolean }) {
  return (
    <>
      <CommandError error={ws.placer.error} />
      {ws.held && (
        <UnplacedRefused
          consoleMode={consoleMode}
          held={ws.held}
          place={ws.pathOf(ws.held.target.unitId)}
          pending={ws.placer.isPending}
          onRest={() => ws.placer.mutate({ people: ws.held!.rest, target: ws.held!.target, setup: ws.held!.setup, effectiveDate: ws.held!.effectiveDate })}
          onCancel={() => ws.setHeld(null)}
        />
      )}
      {ws.receipt && <Receipt placement="docked" state="applied" message={ws.receipt} onDismiss={() => ws.setReceipt(null)} />}
    </>
  );
}
