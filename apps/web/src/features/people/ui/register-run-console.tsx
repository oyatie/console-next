// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode, RefObject } from "react";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { modHint } from "../../../lib/mod-hint";
import { CommandError } from "../../../lib/react/command-error";
import type { ReadState } from "../../../lib/react/query-view";
import { Button } from "../../../ui/button/button";
import { Kbd } from "../../../ui/kbd/kbd";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PhaseLine } from "../../../ui/page-head/phase-line";
import { WizardPattern } from "../../../ui/patterns/wizard";
import { useMountFocus } from "../../../ui/page/use-mount-focus";
import type { PathOption } from "../../../ui/path-picker/path-picker";
import { peopleRefusal } from "../present";
import type { DuplicateCandidate } from "../api";
import type { CarryKey, Draft, DupPick, Gap } from "../domain/register";
import type { PlaceOption } from "../domain/register-place";
import { RegisterDup } from "./register-dup";
import { RegisterToast } from "./register-toast";
import { RunCarry } from "./register-run-carry";
import { RunSide } from "./register-run-side";
import { RunTable, type RunRow } from "./register-run-table";
import s from "./register-run.module.css";

export function RegisterRunConsole({
  q,
  bodyRef,
  title,
  setup,
  liveCount,
  chosenUnitName,
  chosenHeadcount,
  d,
  set,
  hireText,
  onHire,
  today,
  carry,
  onCarry,
  rows,
  showAll,
  onShowAll,
  places,
  options,
  carried,
  shownGaps,
  tried,
  gapList,
  cands,
  mine,
  pick,
  onPick,
  regError,
  undoError,
  dups,
  undoing,
  onUndoRow,
  onUndoAll,
  onSave,
}: {
  q: ReadState;
  bodyRef: RefObject<HTMLDivElement | null>;
  title: string;
  setup: boolean;
  liveCount: number;
  chosenUnitName?: string;
  chosenHeadcount?: number;
  d: Draft;
  set: <K extends keyof Draft>(k: K, v: Draft[K]) => void;
  hireText: string;
  onHire: (text: string) => void;
  today: string;
  carry: ReadonlySet<CarryKey>;
  onCarry: (next: ReadonlySet<CarryKey>) => void;
  rows: readonly RunRow[];
  showAll: boolean;
  onShowAll: () => void;
  places: readonly PathOption[];
  options: readonly PlaceOption[];
  carried: (k: CarryKey) => boolean;
  shownGaps: ReadonlySet<Gap>;
  tried: boolean;
  gapList: readonly Gap[];
  cands: readonly DuplicateCandidate[];
  mine: { name: string; birth: string; place: string; hire: string; status: string; number: string | null };
  pick: DupPick;
  onPick: (p: DupPick) => void;
  regError: unknown;
  undoError: unknown;
  dups: number;
  undoing: boolean;
  onUndoRow: (r: RunRow) => void;
  onUndoAll: () => void;
  onSave: (finish: boolean) => void;
}) {
  useMountFocus(q.data !== undefined, () => bodyRef.current?.querySelector<HTMLElement>('[data-run="name"]') ?? null);
  const actions: ReactNode = (
    <>
      {liveCount > 0 && (
        <Button onClick={() => onSave(true)}>
          {t("register.run.finish")}
          <Kbd keys={modHint("⇧↵")} />
        </Button>
      )}
      <Button variant="primary" onClick={() => onSave(false)}>
        {t("register.run.submit")}
        <Kbd keys={modHint("↵")} />
      </Button>
    </>
  );

  return (
    <WizardPattern
      q={q}
      back={{ to: "/people", label: t("people.title") }}
      head={{
        title,
        crumbs: <Crumbs items={[<Link key="people" to="/people" search={{}} className={s.crumbLink}>{t("people.title")}</Link>]} current={t("register.run.crumb")} />,
        meta: <PhaseLine phase={setup ? "setup" : "operating"}>{t(setup ? "register.run.phaseSetup" : "register.run.phaseOp")}</PhaseLine>,
        tools: (
          <bdi className={s.sum} role="status">
            {t("register.run.sum", { n: liveCount })}
            {chosenUnitName ? <> · {t("register.run.unitNow", { unit: chosenUnitName, count: chosenHeadcount ?? 0 })}</> : null}
          </bdi>
        ),
        actions: liveCount > 0 ? (
          <Button size="sm" onClick={() => onSave(true)}>
            {t("register.run.finish")}
            <Kbd keys={modHint("⇧↵")} />
          </Button>
        ) : undefined,
      }}
      notes={<RunCarry d={d} carry={carry} onCarry={onCarry} placeName={chosenUnitName ?? ""} consoleMode />}
      body={
        <div className={s.main} ref={bodyRef}>
          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Horizontal scroll region needs keyboard access. */}
          <div className={s.wrap} tabIndex={0} role="region" aria-label={t("register.run.title")}>
            <RunTable
              rows={rows}
              showAll={showAll}
              onShowAll={onShowAll}
              d={d}
              set={set}
              hireText={hireText}
              onHire={onHire}
              today={today}
              places={places}
              carried={carried}
              invalid={shownGaps}
              undoable={setup}
              onUndo={onUndoRow}
              onSave={() => onSave(false)}
            />
          </div>
          {cands.length > 0 && (
            <RegisterDup
              mine={mine}
              candidates={cands}
              places={options}
              pick={pick}
              onPick={onPick}
              tried={tried}
            />
          )}
          <RegisterToast />
        </div>
      }
      asideLabel={t("register.run.batchTitle")}
      aside={<RunSide registered={liveCount} errors={tried ? gapList.length : 0} dups={dups} setup={setup} undoing={undoing} onUndoAll={onUndoAll} />}
      notice={
        <>
          {tried && gapList.length > 0 && (
            <div role="alert" className={s.err}>
              {t("register.foot.errors", { n: gapList.length, list: gapList.map((x) => t(`register.field.${x}`)).join(" · ") })}
            </div>
          )}
          {cands.length === 0 && <CommandError error={regError} own={peopleRefusal} />}
          <CommandError error={undoError} />
        </>
      }
      actions={actions}
      statusSegments={[
        { id: "scope", tone: "strong", content: t("register.run.crumb") },
        { id: "count", content: t("register.run.sum", { n: liveCount }) },
      ]}
    />
  );
}
