// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { t } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import type { ReadState } from "../../../lib/react/query-view";
import { Button, IconButton } from "../../../ui/button/button";
import { Kbd } from "../../../ui/kbd/kbd";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { WizardPattern } from "../../../ui/patterns/wizard";
import { StepLine } from "../../../ui/step-line/step-line";

type Step = { key: string; label: string; state: "done" | "current" | "waiting" };

export function GridConsole({
  q,
  scope,
  steps,
  step,
  body,
  errors,
  changedPeople,
  nowCells,
  secondCells,
  previewCounts,
  checkPending,
  commitPending,
  hasRowsToCheck,
  error,
  onFirstError,
  onCheck,
  onBack,
  onCommit,
  onClose,
}: {
  q: ReadState;
  scope: string;
  steps: readonly Step[];
  step: "edit" | "check" | "done";
  body: ReactNode;
  errors: number;
  changedPeople: number;
  nowCells: number;
  secondCells: number;
  previewCounts: { people: number; cells: number; refused: number } | null;
  checkPending: boolean;
  commitPending: boolean;
  hasRowsToCheck: boolean;
  error: unknown;
  onFirstError: () => void;
  onCheck: () => void;
  onBack: () => void;
  onCommit: () => void;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || !(e.metaKey || e.ctrlKey) || e.isComposing || e.keyCode === 229) return;
      if (step === "done") return;
      e.preventDefault();
      if (step === "edit" && hasRowsToCheck) onCheck();
      if (step === "check") onCommit();
    };
    const node = bodyRef.current;
    node?.addEventListener("keydown", onKey);
    return () => node?.removeEventListener("keydown", onKey);
  }, [step, hasRowsToCheck, onCheck, onCommit]);

  return (
    <WizardPattern
      q={q}
      back={{ to: "/people", label: t("people.title") }}
      head={{
        title: t("bulkGrid.title", { scope }),
        crumbs: <Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} current={t("bulkGrid.crumb")} />,
        actions: (
          <IconButton label={t("bulk.page.close")} onClick={onClose}>
            <X size={16} aria-hidden />
          </IconButton>
        ),
      }}
      steps={<StepLine steps={[...steps]} label={t("bulk.page.steps")} />}
      body={<div ref={bodyRef}>{body}</div>}
      notice={
        step !== "done" ? (
          <CommandError
            error={error}
            own={(code) => (code === "rows_changed_since_preview" ? t("bulkGrid.changedMeanwhile") : undefined)}
          />
        ) : undefined
      }
      consequence={
        step === "done"
          ? undefined
          : step === "check" && previewCounts
            ? <b>{t(previewCounts.refused ? "bulkGrid.preview.foot" : "bulkGrid.preview.footClean", { ...previewCounts, n: previewCounts.people })}</b>
            : <b>{t("bulkGrid.foot", { n: changedPeople, now: nowCells, second: secondCells, errors })}</b>
      }
      actions={
        step === "done" ? null : step === "edit" ? (
          <>
            {errors > 0 && (
              <Button onClick={onFirstError}>
                {t("bulkGrid.firstError")}
                <Kbd keys="F8" />
              </Button>
            )}
            <Button variant="primary" aria-disabled={checkPending || !hasRowsToCheck || undefined} onClick={() => hasRowsToCheck && onCheck()}>
              {errors ? t("bulkGrid.toCheck", { n: errors }) : t("bulkGrid.toCheckClean")}
              <Kbd keys="⌘↵" />
            </Button>
          </>
        ) : previewCounts ? (
          <>
            <Button variant="ghost" onClick={onBack}>
              {t("bulkGrid.back")}
            </Button>
            <Button variant="primary" aria-disabled={commitPending || undefined} onClick={onCommit}>
              {t("bulkGrid.commit", { n: previewCounts.people, cells: previewCounts.cells })}
              <Kbd keys="⌘↵" />
            </Button>
          </>
        ) : null
      }
      statusSegments={[
        { id: "scope", tone: "strong", content: t("bulkGrid.crumb") },
        { id: "step", content: steps.find((x) => x.key === step)?.label ?? t("bulkGrid.crumb") },
      ]}
    />
  );
}
