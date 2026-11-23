// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { CommandError } from "../../../lib/react/command-error";
import type { ReadState } from "../../../lib/react/query-view";
import type { components } from "@console/api/schema";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { Kbd } from "../../../ui/kbd/kbd";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { WizardPattern } from "../../../ui/patterns/wizard";
import { Receipt } from "../../../ui/receipt/receipt";
import { StepLine } from "../../../ui/step-line/step-line";
import type { RenewBatch } from "../domain/renew";
import s from "./bulk-page.module.css";

type Employee = components["schemas"]["Employee"];
type Step = { key: string; label: string; state: "done" | "current" | "waiting" };

export function RenewConsole({
  q,
  peopleCount,
  steps,
  notes,
  body,
  aside,
  refusedBanner,
  done,
  leaving,
  tried,
  gaps,
  openCount,
  pending,
  error,
  renewCount,
  convertCount,
  onSubmit,
}: {
  q: ReadState;
  peopleCount: number;
  steps: readonly Step[];
  notes: ReactNode;
  body: ReactNode;
  aside: ReactNode;
  refusedBanner: ReactNode;
  done: RenewBatch[] | null;
  leaving: readonly Employee[];
  tried: boolean;
  gaps: readonly string[];
  openCount: number;
  pending: boolean;
  error: unknown;
  renewCount: number;
  convertCount: number;
  onSubmit: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || !(e.metaKey || e.ctrlKey) || e.isComposing || e.keyCode === 229) return;
      if (done) return;
      e.preventDefault();
      onSubmit();
    };
    const targets = [bodyRef.current, asideRef.current].filter((n): n is HTMLDivElement => Boolean(n));
    for (const node of targets) node.addEventListener("keydown", onKey);
    return () => { for (const node of targets) node.removeEventListener("keydown", onKey); };
  }, [done, onSubmit]);

  return (
    <WizardPattern
      q={q}
      back={{ to: "/people", label: t("people.title") }}
      head={{
        title: t("renew.title", { n: peopleCount }),
        crumbs: <Crumbs items={[<Link key="people" to="/people" search={{}} className={s.crumbLink}>{t("people.title")}</Link>]} current={t("renew.crumb")} />,
      }}
      steps={<StepLine steps={[...steps]} label={t("renew.steps")} />}
      notes={notes}
      body={<div ref={bodyRef}>{body}</div>}
      asideLabel={t("renew.side.title")}
      aside={<div ref={asideRef}>{aside}</div>}
      notice={
        <>
          {refusedBanner}
          {done && (
            <Receipt
              state="recorded"
              message={t("renew.done", { n: done.length })}
              actions={leaving.length > 0 && <bdi className="muted">{t("renew.done.exits", { n: leaving.length })}</bdi>}
            />
          )}
          <CommandError error={error} />
        </>
      }
      consequence={
        <>
          {done
            ? done.map((b) => (
                <Chip key={`${b.choice}${b.effective}`} tone="info">
                  {t("renew.done.batch", { kind: t(`renew.choice.${b.choice}`), count: b.ids.length, date: fmtDate(b.effective) })}
                </Chip>
              ))
            : tried && gaps.length
              ? <strong>{gaps.join(" · ")}</strong>
              : <bdi>{openCount ? t("renew.commitNone") : t("renew.law")}</bdi>}
          {done && leaving.map((e) => (
            <Link key={e.id} className={buttonClass("ghost")} to="/people/$id" params={{ id: e.id }} search={{ act: "exit.report" }}>
              {t("renew.exit", { name: e.name })}
            </Link>
          ))}
        </>
      }
      actions={
        !done ? (
          <Button variant="primary" aria-disabled={pending || undefined} onClick={onSubmit}>
            {t("renew.commit", { renew: renewCount, convert: convertCount })}
            <Kbd keys="⌘↵" />
          </Button>
        ) : null
      }
      statusSegments={[
        { id: "scope", tone: "strong", content: t("renew.crumb") },
        { id: "count", content: String(peopleCount) },
      ]}
    />
  );
}
