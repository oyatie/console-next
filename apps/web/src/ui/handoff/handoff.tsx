import { useId, type ReactNode } from "react";
import { ArrowRight, EyeOff, TriangleAlert } from "lucide-react";
import { t } from "@console/i18n";
import css from "./handoff.module.css";

/**
 * Two-person handoff: the same item sits in the requester's waiting lane and the receiver's my-turn lane. Each side names
 * the person and what they see; the requester's side never shows the value the receiver must re-enter.
 */
export function HandoffState({ from, to, title }: {
  title: ReactNode;
  from: { who: ReactNode; note: ReactNode };
  to: { who: ReactNode; note: ReactNode };
}) {
  return (
    <div className={css.handoff}>
      <section className={css.hand} aria-label={t("uiHandoff.waiting")}>
        <div className={css.head}><span>{from.who}</span><span>{t("uiHandoff.waiting")}</span></div>
        <div className={css.item}><b>{title}</b><span className={css.note}>{from.note}</span></div>
      </section>
      <ArrowRight className={css.arrow} aria-hidden="true" />
      <section className={css.hand} aria-label={t("uiHandoff.mine")}>
        <div className={css.head}><span>{to.who}</span><span>{t("uiHandoff.mine")}</span></div>
        <div className={css.item}><b>{title}</b><span className={css.note}>{to.note}</span></div>
      </section>
    </div>
  );
}

/**
 * Blind re-entry: wraps the second person's field and says the first value stays hidden until the server compares.
 * The field is a render prop that gets the hint's id for its aria-describedby (as round 1's Field hands ids over).
 */
export function BlindReentry({ children }: { children: (describedBy: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={css.blindField}>
      {children(id)}
      <span id={id} className={css.blind}><EyeOff aria-hidden="true" />{t("uiHandoff.blind")}</span>
    </div>
  );
}

/**
 * The server found the two entries differ (409): both values side by side, each with who entered it, and the
 * remedies as a slot (send back to the first person, or correct with a reason code). Nothing is applied.
 */
export function MismatchCompare({ title, code, values, remedies, note }: {
  title: ReactNode;
  code: string;
  values: [{ who: ReactNode; value: ReactNode }, { who: ReactNode; value: ReactNode }];
  remedies: ReactNode;
  note?: ReactNode;
}) {
  return (
    <section className={css.mismatch} role="alert">
      <div className={css.mismatchHead}>
        <TriangleAlert aria-hidden="true" />
        <h3>{title}</h3>
        <span className="code">{code}</span>
      </div>
      <dl className={css.compare}>
        {values.map((v, i) => (
          <div key={i}><dt>{v.who}</dt><dd>{v.value}</dd></div>
        ))}
      </dl>
      <div className="row">{remedies}</div>
      {note && <span className={css.note}>{note}</span>}
    </section>
  );
}
