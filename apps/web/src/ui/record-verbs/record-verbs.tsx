import { useId, type ReactNode } from "react";
import { Button } from "react-aria-components";
import { t } from "@console/i18n";
import css from "./record-verbs.module.css";

/** The only three verbs on an existing record: change (before it applies), correct (fix an applied record), withdraw. */
export type RecordVerb = "amend" | "correct" | "withdraw";

/** One verb as the server's `next_actions` reports it; a verb it does not allow carries why, shown beside the control. */
export type VerbAction = { verb: RecordVerb; allowed: boolean; why?: ReactNode };

/**
 * Change, correct, withdraw, in that order, from the server's `next_actions`. A disallowed verb stays visible with its reason
 * next to it (not a tooltip) so the user learns what to do instead; `why` may carry the remedy (record a new act).
 * Buttons read verb + object (change the transfer).
 */
export function RecordVerbs({ object, actions, onVerb, pending }: {
  /** The record's act as a noun (transfer, promotion). */
  object: string;
  actions: VerbAction[];
  onVerb: (verb: RecordVerb) => void;
  pending?: RecordVerb;
}) {
  const id = useId();
  // All three always show; a verb the server did not report is not allowed (the server enforces either way).
  const order: RecordVerb[] = ["amend", "correct", "withdraw"];
  const shown = order.map((verb): VerbAction => actions.find((a) => a.verb === verb) ?? { verb, allowed: false });
  return (
    <ul className={css.verbs} aria-label={t("uiRecordVerbs.label", { object })}>
      {shown.map((a) => (
        <li key={a.verb} className={css.verb} data-allowed={a.allowed}>
          <b>{t(`uiRecordVerbs.verb.${a.verb}`)}</b>
          <span id={`${id}-${a.verb}`} className={css.desc}>{a.allowed ? t(`uiRecordVerbs.desc.${a.verb}`) : (a.why ?? t(`uiRecordVerbs.why.${a.verb}`))}</span>
          <Button
            className={`btn ${a.verb === "withdraw" && a.allowed ? "btn--ghost btn--danger" : ""}`}
            isDisabled={!a.allowed || (pending !== undefined && pending !== a.verb)}
            isPending={pending === a.verb}
            aria-describedby={`${id}-${a.verb}`}
            onPress={() => onVerb(a.verb)}
          >
            {t(`uiRecordVerbs.button.${a.verb}`, { object })}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * What a withdrawal takes down with it, listed before the commit (the server computes the list).
 * `who` says whether it happens automatically or whom it notifies.
 */
export function WithdrawCascade({ items }: { items: { key: string; what: ReactNode; who: ReactNode }[] }) {
  return (
    <section className={css.cascade} aria-label={t("uiRecordVerbs.cascade")}>
      <h3 className={css.cascadeHead}>{t("uiRecordVerbs.cascade")}</h3>
      {items.length === 0 ? (
        <p className={css.desc}>{t("uiRecordVerbs.cascade.none")}</p>
      ) : (
        <ul className={css.cascadeList}>
          {items.map((i) => (
            <li key={i.key}>
              <span>{i.what}</span>
              <span className={css.desc}>{i.who}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
