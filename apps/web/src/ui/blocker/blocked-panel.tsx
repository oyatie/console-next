import { useId, type ReactNode } from "react";
import { Ban, GitCompareArrows, Lock, Route } from "lucide-react";
import { t } from "@console/i18n";
import { SupportReference } from "../../lib/react/support-reference";
import s from "./blocker.module.css";

export type Unblocker = { name: string; role?: string };
export type BlockedKind = "lock" | "route" | "mismatch" | "generic";

const ICON = { lock: Lock, route: Route, mismatch: GitCompareArrows, generic: Ban } as const;

/**
 * A server refusal the user cannot override here (components.html §6, server-refusal-with-fix). Use
 * it only for a true invariant the server refused; a rule that allows exceptions goes to the exception
 * sheet instead. The panel always names the refusal code, at least one person who can unblock it, and
 * at least one action, so a refusal is never a dead end. Map a problem to these props in lib/refusal.
 */
export function BlockedPanel({ kind = "generic", compact, title, domain = "work", code, supportRef, supportRefAt, owner, children, ability, unblockers, actions }: {
  kind?: BlockedKind;
  title: string;
  code: string;
  domain?: string;
  supportRef?: string;
  supportRefAt?: string;
  /** What happened and why, in the server's words or catalog copy. */
  children?: ReactNode;
  /** The permission that can unblock it, e.g. period lock management. */
  ability?: string;
  /** The remedies: change the input, or ask an unblocker (an action that reaches them). */
  actions: ReactNode;
} & ({ compact: true; owner?: ReactNode; unblockers?: readonly Unblocker[] } | { compact?: false; owner?: never; unblockers: readonly [Unblocker, ...Unblocker[]] })) {
  const id = useId();
  const Icon = ICON[kind];
  const refusalCode = `${domain}.refuse.${code}`;
  if (compact) {
    return (
      <section className={s.panel} data-compact="" role="alert" aria-labelledby={id}>
        <div className={s.head}>
          <Icon className={s.icon} size={16} aria-hidden />
          <h3 id={id} className={s.title}>{title}</h3>
          {owner != null && <small className={s.whoLabel}>{owner}</small>}
          <div className={s.actions} role="group" aria-label={t("uiBlocker.remedies")}>{actions}</div>
        </div>
        <details className={s.reason}>
          <summary>{t("uiBlocker.reason")}</summary>
          <code className={s.code}>{refusalCode}</code>
          <SupportReference reference={supportRef} at={supportRefAt} />
        </details>
        {children != null && <div className={s.compactBody}>{children}</div>}
      </section>
    );
  }
  return (
    <section className={s.panel} role="alert" aria-labelledby={id}>
      <div className={s.head}>
        <Icon className={s.icon} size={18} aria-hidden />
        <h3 id={id} className={s.title}>{title}</h3>
      </div>
      {children != null && <div className={`${s.body} prose`}>{children}</div>}
      <details className={s.body}>
        <summary>{t("uiBlocker.reason")}</summary>
        <code className={s.code}>{refusalCode}</code>
        <SupportReference reference={supportRef} at={supportRefAt} />
      </details>
      <div className={s.unblock}>
        <span className={s.whoLabel}>{ability ? t("uiBlocker.who.ability", { ability }) : t("uiBlocker.who")}</span>
        <ul className={s.who}>
          {unblockers.map((u) => (
            <li key={u.name + (u.role ?? "")}>
              <span className={s.name}>{u.name}</span>
              {u.role && <span className={s.role}>{u.role}</span>}
            </li>
          ))}
        </ul>
        <div className={s.actions} role="group" aria-label={t("uiBlocker.remedies")}>{actions}</div>
      </div>
    </section>
  );
}
