import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "react-aria-components";
import { t } from "@console/i18n";
import css from "./approval-card.module.css";

type Form = "reject" | "return";
/**
 * Which command is in flight; every control is inert while one is (the card is aria-busy), and nothing shows as
 * done until the server's receipt. Not React Aria's isPending: its announcement points at the button by id, and
 * the decided card unmounts it, leaving a nameless live node behind (axe role-img-alt).
 */
export type ApprovalPending = "approve" | Form | undefined;

/**
 * Request changes, all three or none: without it the card offers approve and reject only (a record kind
 * whose server has no request-changes command yet).
 */
type ReturnProps =
  | { returnLabel: string; returnConsequence: ReactNode; onReturn: () => void }
  | { returnLabel?: never; returnConsequence?: never; onReturn?: never };

/**
 * Desktop executive approval card: one item, only the step this person holds. The consequence sentence sits
 * above all three decisions, and reject and request-changes stand at the same height as approve. Choosing either
 * opens a reason form whose commit stays disabled, with the reason beside it, until `reasonComplete`.
 * The reason field itself is a slot (ReasonField from DS-02); the card owns no codes and no other-needs-a-memo rule.
 * Key the card by the item id, so the open form never carries over to the next item.
 */
export function ApprovalCard(p: ReturnProps & {
  /** Kind and record id (org change · OC-2026-0418). */
  eyebrow: ReactNode;
  /** The step this person holds (my step · delegated, 1 step). */
  step: ReactNode;
  /** The decision as a sentence (dissolves the support team on 2 Nov). */
  title: ReactNode;
  /** Content, preflight in words, diff, chain (TaskCard slots). */
  children: ReactNode;
  /** What approving does and who can undo it. Required: the type forces the sentence above the decision. */
  consequence: ReactNode;
  /** What reject / request changes do, shown above the form's commit. */
  rejectConsequence: ReactNode;
  /** Verb + object for each commit (approve the dissolution; reject the dissolution; ...). */
  approveLabel: string;
  rejectLabel: string;
  /** The reason field for the open form (codes + memo). */
  reason: (form: Form) => ReactNode;
  /** The reason field is complete (a code; "other" with a memo). */
  reasonComplete: boolean;
  /** What is missing while it is not, beside the commit (defaults to choosing a reason code). */
  reasonMissing?: ReactNode;
  onApprove: () => void;
  onReject: () => void;
  pending?: ApprovalPending;
  /** Why approve cannot be pressed now (e.g. the content changed while reviewing); shown next to it. */
  approveBlocked?: ReactNode;
  /** Queue position (1st of 3 left) and its bar. */
  progress?: ReactNode;
  /** Left of the decisions: when the card was opened and its content fingerprint. */
  meta?: ReactNode;
  /** The server receipt once recorded; it replaces the decisions. */
  receipt?: ReactNode;
  /** The open-next-approval link, placed away from where approve was. */
  next?: ReactNode;
}) {
  const [form, setForm] = useState<Form>();
  const formHead = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useEffect(() => {
    if (form) formHead.current?.focus();
  }, [form]);
  const busy = p.pending !== undefined;

  if (p.receipt) {
    return (
      <article className={`card ${css.card}`}>
        {p.progress && <div className={css.progress}>{p.progress}</div>}
        <div className={css.done}>
          {p.next && <div className={css.next}>{p.next}</div>}
          {p.receipt}
        </div>
      </article>
    );
  }

  return (
    <article className={`card ${css.card}`} aria-busy={busy || undefined}>
      {p.progress && <div className={css.progress}>{p.progress}</div>}
      <div className={css.body}>
        <div className={css.eyebrow}>{p.eyebrow}</div>
        <span className={css.step}>{p.step}</span>
        <h2 className={css.title}>{p.title}</h2>
        {p.children}
      </div>
      {form ? (
        <section className={css.form} aria-labelledby={`${id}-form`}>
          <h3 id={`${id}-form`} ref={formHead} tabIndex={-1} className={css.formHead}>
            {form === "reject" ? p.rejectLabel : p.returnLabel}
          </h3>
          {p.reason(form)}
          <div id={`${id}-then`} className={css.consequence} role="note">{form === "reject" ? p.rejectConsequence : p.returnConsequence}</div>
          <div className={css.bar}>
            <Button className="btn" isDisabled={busy} onPress={() => setForm(undefined)}>{t("uiApprovalCard.back")}</Button>
            <span className={css.spacer} />
            {!p.reasonComplete && <span id={`${id}-why`} className={css.why}>{p.reasonMissing ?? t("uiApprovalCard.reasonMissing")}</span>}
            <Button
              className={`btn ${form === "reject" ? "btn--danger" : "btn--primary"}`}
              isDisabled={!p.reasonComplete || busy}
              aria-describedby={p.reasonComplete ? `${id}-then` : `${id}-why`}
              onPress={form === "reject" ? p.onReject : p.onReturn}
            >
              {form === "reject" ? p.rejectLabel : p.returnLabel}
            </Button>
          </div>
        </section>
      ) : (
        <>
          <div id={`${id}-then`} className={css.consequence} role="note">{p.consequence}</div>
          <div className={css.bar}>
            {p.approveBlocked && <span id={`${id}-blocked`} className={`${css.why} ${css.whyLine}`}>{p.approveBlocked}</span>}
            {p.meta && <span className={css.meta}>{p.meta}</span>}
            <span className={css.spacer} />
            <Button className="btn" isDisabled={busy} onPress={() => setForm("reject")}>{t("uiApprovalCard.reject")}</Button>
            {p.onReturn && <Button className="btn" isDisabled={busy} onPress={() => setForm("return")}>{t("uiApprovalCard.return")}</Button>}
            <Button
              className="btn btn--primary"
              isDisabled={Boolean(p.approveBlocked) || busy}
              aria-describedby={p.approveBlocked ? `${id}-blocked` : `${id}-then`}
              onPress={p.onApprove}
            >
              {p.approveLabel}
            </Button>
          </div>
        </>
      )}
    </article>
  );
}
