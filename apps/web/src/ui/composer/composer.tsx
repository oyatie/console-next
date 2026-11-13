// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useId, useRef, type ReactNode } from "react";
import { t } from "@console/i18n";
import { Button, Form } from "../button/button";
import { Checks } from "../choice/checks";
import { DisabledReason } from "../disabled-reason/disabled-reason";
import { Kbd } from "../kbd/kbd";
import { PageHead } from "../page-head/page-head";
import { Sheet } from "../sheet/sheet";
import { commitLabel, type ActionDescription } from "./actions";
import { RoutingPreview, type ComposerRouting } from "./routing";
import s from "./composer.module.css";

const PREVIEW_ORDER = ["preflight", "effects", "approvals", "documents", "deadlines", "tasks", "access", "payroll"] as const;
type PreviewSections = Partial<Record<typeof PREVIEW_ORDER[number], ReactNode>>;

/** One governed form, in a drawer or a page. API calls, refusals and recovery remain with the action's owner. */
export function Composer(p: {
  formId?: string;
  commitId?: string;
  layout?: "drawer" | "page" | "inline";
  headingLevel?: 2 | 3 | 4;
  open?: boolean;
  size?: "md" | "lg";
  kicker?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  tools?: ReactNode;
  action: ActionDescription;
  onClose?: () => void;
  pending?: boolean;
  loading?: boolean;
  locked?: boolean;
  /** The command error locks writes after an authoritative permission denial; render its refusal in notice. */
  error?: unknown;
  notice?: ReactNode;
  sections?: PreviewSections;
  routing?: ComposerRouting;
  consequence?: ReactNode;
  signoffs?: { items: readonly { id: string; label: string }[]; value: readonly string[]; onChange: (value: string[]) => void; missing: boolean };
  tone?: "primary" | "danger";
  missing?: number;
  incomplete?: boolean;
  blocked?: { reason: ReactNode; remedy?: ReactNode; press?: () => void };
  secondary?: ReactNode;
  recovery?: ReactNode;
  dirty?: boolean;
  localDraft?: boolean;
  draftAction?: ActionDescription;
  draftTone?: "primary" | "secondary";
  onSaveDraft?: () => void;
  onSubmit?: () => boolean | void;
  children: ReactNode;
}) {
  const generatedId = useId();
  const id = p.formId ?? generatedId;
  const refused = typeof p.error === "object" && p.error !== null && "status" in p.error && p.error.status === 403;
  const locked = p.locked || refused;
  const submitter = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (p.open === false) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || !(e.metaKey || e.ctrlKey) || e.isComposing || e.keyCode === 229 || !document.getElementById(id)?.closest('[role="dialog"], [data-composer-root]')?.contains(document.activeElement)) return;
      e.preventDefault();
      submitter.current?.click();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [p.open, id]);
  if (p.open === false) return null;
  const sections = { ...p.sections, effects: p.sections?.effects ?? p.consequence };
  if (p.routing) sections.approvals = p.routing.routed && <RoutingPreview routing={p.routing} />;
  const signoffs = p.signoffs && p.signoffs.items.length > 0 && (
    <Checks label={t("composer.signoffs")} items={p.signoffs.items} value={p.signoffs.value} onChange={p.signoffs.onChange} isDisabled={p.pending || locked} error={p.signoffs.missing ? t("composer.signoffs.missing") : undefined} />
  );
  const Heading = p.layout === "page" ? "h1" : `h${p.headingLevel ?? 2}` as "h2" | "h3" | "h4";
  const PreviewHeading = `h${p.layout === "page" ? 2 : (p.headingLevel ?? 2) + 1}` as "h2" | "h3" | "h4" | "h5";
  const contents = <>
    {p.children}
    {PREVIEW_ORDER.map((section) => {
      const content = section === "preflight" && signoffs ? <>{sections[section]}{signoffs}</> : sections[section];
      if (content == null || content === false || content === "" || (Array.isArray(content) && content.length === 0)) return null;
      return <section key={section} className={s.section} data-composer-section={section} aria-labelledby={`${id}-${section}`}><PreviewHeading id={`${id}-${section}`} className={s.heading}>{t(`composer.section.${section}`)}</PreviewHeading>{content}</section>;
    })}
  </>;
  const body = p.onSubmit ? (
    <Form id={id} className="form" noValidate onSubmit={() => {
      if (p.pending || p.loading || locked || p.blocked || p.recovery || p.onSubmit?.() !== false) return;
      requestAnimationFrame(() => document.getElementById(id)?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid] input')?.focus());
    }}>
      {contents}
    </Form>
  ) : <div className="form">{contents}</div>;
  const commit = p.onSubmit && <Button className={s.commit} ref={submitter} id={p.commitId} type="submit" form={id} variant={p.tone ?? "primary"} aria-disabled={p.incomplete || undefined} disabled={p.pending || p.loading || locked}>{commitLabel(p.action)}<Kbd keys="⌘↵" /></Button>;
  const actions = <div className={p.layout === "page" ? s.pageActions : s.actions}>{p.recovery ?? <>
    {p.blocked && !refused ? <DisabledReason control={(props) => <Button {...props} ref={submitter} className={`${props.className} ${s.commit}`} id={p.commitId} variant={p.tone ?? "primary"} onClick={(event) => { props.onClick(event); if (!p.pending && !p.loading && !locked) p.blocked?.press?.(); }}>{commitLabel(p.action)}</Button>} reason={p.blocked.reason} remedy={p.blocked.remedy} /> : commit}
    {p.missing ? <span role="status">{t("composer.missing", { count: p.missing })}</span> : null}
    {refused && p.secondary ? <div inert>{p.secondary}</div> : p.secondary}
    {p.onSaveDraft && <Button variant={p.draftTone} disabled={p.pending || locked} title={p.localDraft ? t("composer.draftHint") : undefined} onClick={p.onSaveDraft}>{p.draftAction ? commitLabel(p.draftAction) : t("composer.saveDraft")}</Button>}
    {p.onClose && (p.layout === "page" || p.layout === "inline") && <Button variant="ghost" disabled={p.pending} onClick={p.onClose}>{t("composer.dismiss")}</Button>}
  </>}</div>;
  const routing = p.routing?.routed === false && <RoutingPreview routing={p.routing} />;
  if (p.layout !== "page" && p.layout !== "inline") return <Sheet open kicker={p.kicker} title={p.title} subtitle={p.subtitle} onClose={() => p.onClose?.()} pending={p.pending} loading={p.loading} locked={locked} size={p.size} notice={p.notice} consequence={routing} actions={actions} {...(p.dirty === undefined ? {} : { dirty: p.dirty })}>{body}</Sheet>;
  return <section className={`${s.page} ${p.layout === "page" ? s.fullPage : ""}`} data-composer-root aria-labelledby={p.layout === "page" ? `${id}-title` : undefined}>
    {p.layout === "page" ? <PageHead band title={p.title} titleId={`${id}-title`} crumbs={p.kicker} sub={p.subtitle} tools={p.tools} /> : <header className={s.head}>{p.kicker}<Heading className={s.heading} id={`${id}-title`}>{p.title}</Heading>{p.subtitle != null && <div>{p.subtitle}</div>}</header>}
    <div inert={p.pending || locked || undefined}>{body}</div>
    <footer className={p.layout === "inline" ? s.inlineFoot : s.foot}>{p.notice}{routing}{actions}</footer>
  </section>;
}
