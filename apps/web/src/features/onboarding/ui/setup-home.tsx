import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Checklist, ChecklistStep } from "@console/api/pending";
import { t, type MessageId } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { codeText } from "../../../lib/labels";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Chip } from "../../../ui/chip";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { StatRow } from "../../../ui/key-value/key-value";
import { entitiesRef } from "../../../reference/entity/api";
import { currentStep, SetupRail, type SetupStepView } from "../../../ui/setup-rail/setup-rail";
import { SETUP_READS, skipStep } from "../api";
import { fixFor } from "../domain/rail";
import { FixLink } from "./fix-link";
import { AddPasskey } from "./add-passkey";
import { SetupBulk } from "./setup-bulk";
import { onboardingError } from "../present";
import { SecurityContact } from "./security-contact";
import { unitsQuery } from "../../../reference/org/api";

// shortcut: prerequisite remedy codes stand in for blocked_by until the checklist supplies the step key.
const WAITING_FOR: Record<string, MessageId> = { create_legal_entity: "setup.step.entity", create_workplace: "setup.step.workplace" };

/** Home keeps the server's step order, states and available actions in one setup rail. */
export function SetupHome({ c }: { c: Checklist }) {
  const [contact, setContact] = useState(false);
  const skip = useCommand({ run: skipStep, invalidates: SETUP_READS });
  const entities = useQuery(entitiesRef);
  // A workplace's own unit (decision #14) lets people be registered with no department; the org hint says which holds.
  const direct = useQuery(unitsQuery).data?.items.some((u) => u.kind === "SITE" && u.status === "ACTIVE") ?? false;
  const needsWorkplace = entities.data?.items.find((e) => !e.closed_on && !e.primary_workplace_id);
  // The entity list fallback waits for a fresh read: stale data (from before the entity existed) would point there.
  const settled = entities.isSuccess && (Boolean(needsWorkplace) || !entities.isFetching);
  const current = currentStep(c.steps);
  const orgAllowed = c.steps.some((s) => s.key === "org" && s.can_act);
  const action = (s: ChecklistStep): ReactNode => {
    const variant = s.key === current ? "primary" : undefined;
    switch (s.key) {
      case "entity": return <Link to="/org/entities/new" className={buttonClass(variant)}>{t("setup.action.entity")}</Link>;
      case "workplace":
        // Straight to the new workplace of the entity that has none (the usual first run); otherwise the entity list.
        // Not offered until the entities are read, so the link never changes under the pointer.
        if (!settled) return null;
        return needsWorkplace ? (
          <Link to="/org/entities/$id/workplaces/new" params={{ id: needsWorkplace.id }} className={buttonClass(variant)}>{t("setup.action.workplace")}</Link>
        ) : (
          <Link to="/org/entities" className={buttonClass(variant)}>{t("setup.action.workplace")}</Link>
        );
      case "org": return <Link to="/org" search={{}} className={buttonClass(variant)}>{t("setup.action.org")}</Link>;
      // The seeded representative route resolves on its own; the only act here is inviting someone who can also decide.
      case "approval": return null;
      // The contact store (#7) may not exist on this server yet: the remedy then says so, with no button.
      case "people": return s.remedy === "security_contact_store_pending" ? null : <Button variant={variant} onClick={() => setContact(true)}>{t("setup.action.people")}</Button>;
      // governance-20: one more passkey, added here in one press (a step-up with the one this account holds).
      case "passkey": return <AddPasskey count={s.count ?? 0} primary={s.key === current} />;
      case "employees": return <Link to="/people/new" search={{}} className={buttonClass(variant)}>{t("setup.action.employees")}</Link>;
      case "roles": return <Link to="/access/roles/new" className={buttonClass(variant)}>{t("setup.action.roles")}</Link>;
      case "golive": return <Link to="/setup/go-live" className={buttonClass(variant)}>{t("setup.action.golive")}</Link>;
    }
  };
  // A step blocked on the missing workplace links to that workplace's form too, once the entities are read.
  const remedy = (code: string, primary: boolean): ReactNode => {
    if (code !== "create_primary_workplace" && code !== "create_workplace") return <FixLink code={code} primary={primary} />;
    if (!settled) return null;
    if (!needsWorkplace) return <FixLink code={code} primary={primary} />;
    return <Link to="/org/entities/$id/workplaces/new" params={{ id: needsWorkplace.id }} className={buttonClass(primary ? "primary" : undefined)}>{codeText(`setup.fix.${code}`, t("setup.fix.open"))}</Link>;
  };
  const view = (s: ChecklistStep): SetupStepView => {
    const waiting = s.state === "blocked" ? WAITING_FOR[s.remedy ?? ""] : undefined;
    const detail = s.remedy
      ? codeText(`setup.remedy.${s.remedy}`, s.remedy, { count: s.count ?? 0 })
      : s.key === "org" && s.skippable && s.state === "todo" ? t(direct ? "setup.org.placementDirect" : "setup.org.placementDept") : s.key === "passkey" && s.state !== "done" ? t("setup.passkey.why") : undefined;
    return {
      key: s.key,
      title: codeText(`setup.step.${s.key}`, s.key),
      state: s.state,
      detail: waiting ? <Chip>{t("setup.waiting", { step: t(waiting) })}</Chip> : <>
        <small>{codeText(`setup.why.${s.key}`, "")}</small>
        {s.key === "roles" && <><Chip>{t("setup.roles.prepared")}</Chip>
          {(s.skippable || s.remedy === "roles_skipped") && <Chip>{t("setup.skip.rolesConsequence")}</Chip>}</>}
        {s.key === "employees" && <Chip tone="warn">{t("setup.stats.unplacedCount", { count: s.counts.unplaced })} · {t("setup.stats.unknownCount", { count: s.counts.entity_unknown })}</Chip>}
        {detail && <><br /><span>{detail}</span></>}
        {!s.can_act && <Chip tone="warn">{t("setup.permissionNeeded", { permission: codeText(`setup.permission.${s.needs}`, s.needs) })}</Chip>}
      </>,
      // Done with something to look at: the action is the fix (when it has a screen), not the step's first act again.
      action: s.can_act && !waiting ? (s.state === "attention" && fixFor(s.remedy) ? <FixLink code={s.remedy} /> : action(s)) : undefined,
      remedy: s.can_act && !waiting && s.remedy ? remedy(s.remedy, s.key === current) : undefined,
      secondary:
        !s.can_act || waiting ? undefined : s.key === "roles" && s.state !== "done" ? (
          <><Link to="/people" search={{ view: "accounts" }} className={buttonClass()}>{t("setup.action.invite")}</Link>
            {s.skippable && <Button variant="ghost" onClick={() => skip.mutate("roles")}>{t("setup.skip.roles")}</Button>}</>
        ) : s.key === "entity" ? (
          <><Link to="/org/entities/bulk" search={{ mode: "paste" }} className={buttonClass()}>{t("setup.path.paste")}</Link>
            <Link to="/org/entities/bulk" search={{ mode: "import" }} className={buttonClass()}>{t("setup.path.import")}</Link></>
        ) : s.key === "employees" && s.state !== "done" ? (
          <>
            <Link to="/people/import" search={{ mode: "paste" }} className={buttonClass()}>{t("setup.path.paste")}</Link>
            <Link to="/people/import" className={buttonClass()}>{t("setup.action.import")}</Link>
            {s.skippable && s.state !== "attention" && <Button variant="ghost" onClick={() => skip.mutate("employees")}>{t("setup.skip.employees")}</Button>}
          </>
        ) : s.key === "org" ? (
          <><Link to="/org/paste" className={buttonClass()}>{t("setup.path.paste")}</Link>
            <Link to="/org/import" className={buttonClass()}>{t("setup.path.import")}</Link>
            {s.skippable && s.state === "todo" && <Button variant="ghost" onClick={() => skip.mutate("org")}>{t("setup.skip.org")}</Button>}</>
        ) : undefined,
    };
  };
  const rail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const openStep = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.defaultPrevented || e.isComposing) return;
      if (e.target instanceof HTMLElement && e.target.matches("[data-step]")) {
        const firstAction = e.target.querySelector<HTMLElement>("a, button:not(:disabled)");
        if (firstAction) { e.preventDefault(); firstAction.click(); }
      }
    };
    el.addEventListener("keydown", openStep);
    return () => el.removeEventListener("keydown", openStep);
  }, []);
  return (
    <div ref={rail} role="group" aria-label={t("setup.title")}>
      <StatRow label={t("setup.stats.label")} items={[...(["people", "placed", "unplaced", "entity_unknown"] as const).map((key) => ({
        key, label: t(`setup.stats.${key}`), value: fmtNumber(c.summary[key]),
      })), ...(c.steps[0] ? (["entities", "workplaces", "units"] as const).map((key) => ({
        key, label: t(key === "entities" ? "setup.golive.details.legal_entity" : key === "workplaces" ? "setup.golive.details.workplace" : "setup.golive.details.units"), value: fmtNumber(c.steps[0]!.counts[key]),
      })) : [])]} />
      <SetupRail
        // Home's own heading already greets the person by name.
        title={t("setup.title")}
        summary={orgAllowed ? <Link to="/org/history">{t("setup.bulk.history")}</Link> : undefined}
        groups={[{ key: "setup", title: t("setup.title"), steps: c.steps.map(view) }]}
      />
      <SetupBulk allowed={orgAllowed} />
      <CommandError error={skip.error} own={onboardingError} />
      {contact && <SecurityContact onClose={() => setContact(false)} />}
    </div>
  );
}
