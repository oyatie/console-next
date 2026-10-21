import { useEffect, useId, useRef, type ReactNode } from "react";
import { t } from "@console/i18n";
import { Button, Form } from "../../../ui/button/button";
import { Checks } from "../../../ui/choice/checks";
import { Sheet } from "../../../ui/sheet/sheet";
import { Kbd } from "../../../ui/kbd/kbd";
import s from "./lifecycle.module.css";

/**
 * A lifecycle action in a side sheet (design §4.1): the form in the body; in the foot, what the server said
 * (`notice`), the one live `consequence` sentence, the server's sign-offs (each unchecked, no "check all"),
 * then back and the commit. The commit is never dead-disabled: a refused submit (`onSubmit` returns false)
 * says beside it how many items still need filling and focuses the first. `actions` replaces back and commit
 * while a lost response is being checked; `locked` then makes the body read-only. `open` counts the inputs still
 * missing before any submit (kept for callers; the foot shows the consequence only, spec E5).
 */
export function LifecycleFrame(p: {
  /** Who and where, above the title (spec E5: 「name · number · place · title」). */
  kicker?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  pending: boolean;
  locked?: boolean;
  notice?: ReactNode;
  consequence: ReactNode;
  signoffs?: { items: readonly { id: string; label: string }[]; value: readonly string[]; onChange: (value: string[]) => void; missing: boolean };
  commit: { label: string; tone: "primary" | "danger" };
  missing: number;
  open?: number;
  actions?: ReactNode;
  onSaveDraft?: () => void;
  onSubmit: () => boolean | void;
  children: ReactNode;
}) {
  const id = useId();
  const acks = p.signoffs && p.signoffs.items.length > 0 ? p.signoffs : null;
  // Cmd/Ctrl+Enter commits from anywhere in the sheet (spec section 3, sheets).
  const submitter = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.isComposing) return;
      e.preventDefault();
      submitter.current?.click();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <Sheet
      open
      kicker={p.kicker}
      title={p.title}
      subtitle={p.subtitle}
      onClose={p.onClose}
      pending={p.pending}
      locked={p.locked}
      notice={p.notice}
      consequence={
        <>
          {p.consequence}
          {acks && (
            <Checks
              label={t("lifecycle.signoffs")}
              items={acks.items}
              value={acks.value}
              onChange={acks.onChange}
              isDisabled={p.pending || p.locked}
              error={acks.missing ? t("lifecycle.signoffs.missing") : undefined}
            />
          )}
        </>
      }
      actions={
        p.actions ?? (
          <>
            <span className="grow" />
            {p.missing > 0 && <span className={s.missing}>{t("lifecycle.missing", { count: p.missing })}</span>}
            {p.onSaveDraft && <Button variant="ghost" disabled={p.pending || p.locked} title={t("empCard.draft.session")} onClick={p.onSaveDraft}>{t("empCard.draft.save")}</Button>}
            <Button variant="ghost" disabled={p.pending} onClick={p.onClose}>{t("lifecycle.cancel")}</Button>
            <Button ref={submitter} type="submit" form={id} variant={p.commit.tone} aria-disabled={p.pending || undefined}>{p.commit.label}<Kbd keys="⌘↵" /></Button>
          </>
        )
      }
    >
      <Form
        id={id}
        className={s.form}
        noValidate
        onSubmit={() => {
          if (p.pending || p.locked || p.onSubmit() !== false) return;
          const dialog = document.getElementById(id)?.closest('[role="dialog"]');
          requestAnimationFrame(() => dialog?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid] input')?.focus());
        }}
      >
        {p.children}
      </Form>
    </Sheet>
  );
}
