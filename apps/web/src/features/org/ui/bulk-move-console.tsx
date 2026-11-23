// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Lock, X } from "lucide-react";
import { t } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import type { ReadState } from "../../../lib/react/query-view";
import { ENTITY_PHASE, labeled } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { commitLabel } from "../../../ui/composer/actions";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { WizardPattern } from "../../../ui/patterns/wizard";
import s from "./bulk-move.module.css";

const isRefused = (error: unknown) =>
  typeof error === "object" && error !== null && "status" in error && (error as { status: unknown }).status === 403;

export function BulkMoveConsole({
  q,
  units,
  title,
  path,
  subtitle,
  setup,
  available,
  canMove,
  tools,
  onClose,
  showClose,
  pending,
  error,
  carriedText,
  blockers,
  consequenceText,
  consequenceNote,
  routedNote,
  whereSection,
  whatSection,
  afterSection,
  afterTitle,
  unmovable,
  mode,
  count,
  onSubmit,
  onSaveDraft,
}: {
  q: ReadState;
  units: ReadState;
  title: string;
  path: readonly string[];
  subtitle?: ReactNode;
  setup: boolean;
  available: boolean;
  canMove: boolean;
  tools?: ReactNode;
  onClose: () => void;
  showClose: boolean;
  pending: boolean;
  error: unknown;
  carriedText?: string;
  blockers: readonly string[];
  consequenceText?: string;
  consequenceNote?: string;
  routedNote?: string;
  whereSection: ReactNode;
  whatSection: ReactNode;
  afterSection: ReactNode;
  afterTitle: string;
  unmovable: ReactNode;
  mode: "request" | "schedule" | "apply";
  count: number;
  onSubmit: () => void;
  onSaveDraft?: () => void;
}) {
  const refused = isRefused(error);
  const locked = pending || refused;
  const actionText = commitLabel({ kind: "orgMove", mode, count });

  const bodyRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || !(e.metaKey || e.ctrlKey) || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      if (available && !locked && blockers.length === 0) onSubmit();
    };
    const targets = [bodyRef.current, asideRef.current].filter((n): n is HTMLDivElement => Boolean(n));
    for (const node of targets) node.addEventListener("keydown", onKey);
    return () => { for (const node of targets) node.removeEventListener("keydown", onKey); };
  }, [available, locked, blockers.length, onSubmit]);

  return (
    <WizardPattern
      q={q}
      head={{
        title,
        crumbs: (
          <Crumbs
            items={[
              <Link key="org" to="/org">{t("orgStructure.title")}</Link>,
              ...path.map((segment, i) => <bdi key={i}>{segment}</bdi>),
            ]}
            current={t("bulkMove.from")}
          />
        ),
        meta: (
          <>
            {subtitle}
            {available && (
              <Chip tone={labeled(ENTITY_PHASE, setup ? "setup" : "operating").tone}>
                {t(setup ? "bulkMove.phaseSetup" : "bulkMove.phaseOperating")}
              </Chip>
            )}
          </>
        ),
        tools,
        actions: showClose ? (
          <Button variant="ghost" icon aria-label={t("orgBulk.close")} onClick={onClose}>
            <X size={16} aria-hidden />
          </Button>
        ) : undefined,
      }}
      notes={carriedText ? <output className={s.lead}>{carriedText}</output> : undefined}
      body={
        <div ref={bodyRef} className={s.consoleBody} inert={locked || undefined}>
          {!canMove ? (
            unmovable
          ) : (
            <QueryState q={units} layout="form">
              {() => (
                <>
                  {whereSection}
                  {whatSection}
                </>
              )}
            </QueryState>
          )}
        </div>
      }
      asideLabel={afterTitle}
      aside={canMove ? <div ref={asideRef} className={s.consoleBody}>{afterSection}</div> : undefined}
      notice={<CommandError focusOnRefusal error={error} />}
      consequence={
        available ? (
          blockers.length > 0 ? (
            <div className={s.reason}>
              <Lock size={14} aria-hidden />
              <bdi>{blockers[0]}</bdi>
            </div>
          ) : (
            <>
              <bdi>{consequenceText}</bdi>
              {consequenceNote ? <bdi className="muted"> · {consequenceNote}</bdi> : null}
              {routedNote ? <bdi className="muted"> · {routedNote}</bdi> : null}
            </>
          )
        ) : undefined
      }
      actions={
        available ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("composer.dismiss")}
            </Button>
            {onSaveDraft && (
              <Button disabled={locked || blockers.length > 0} onClick={onSaveDraft}>
                {t("composer.saveDraft")}
              </Button>
            )}
            {blockers.length > 0 ? (
              <DisabledReason
                reason={blockers.join(", ")}
                control={props => (
                  <Button variant="primary" {...props}>
                    {actionText}
                  </Button>
                )}
              />
            ) : (
              <Button variant="primary" disabled={locked} onClick={onSubmit}>
                {actionText}
              </Button>
            )}
          </>
        ) : undefined
      }
    />
  );
}
