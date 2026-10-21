import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { Avatar } from "../../../ui/avatar/avatar";
import { Chip } from "../../../ui/chip";
import type { Account } from "../api";
import { enforcementText } from "../present";
import s from "./access.module.css";

const facts = (a: Account) => [a.employee_number, a.employee_company, a.employee_org_unit].filter(Boolean).join(" · ");

/**
 * An account as every access screen names it: the name exactly as written, then employee number and placement, so two people with one
 * name are told apart (decision #25). The RRN is never shown or sent here.
 */
export function AccountText({ a }: { a: Account }) {
  const f = facts(a);
  return (
    <span>
      {a.display_name}
      {f && <span className="muted"> {f}</span>}
      {!a.has_passkey && <span className="muted"> · {t("access.account.noPasskey")}</span>}
    </span>
  );
}

/** A person at the head of a sheet or page (mockups M4, M6): initial, name, then employee number, placement and whether they can sign in. */
export function PersonHead({ a, ops, title }: { a: Account; ops?: boolean; title?: ReactNode }) {
  const state = ops ? t("access.account.ops") : t(a.has_passkey ? "access.account.passkey" : "access.account.noPasskey");
  return (
    <span className={s.person}>
      <Avatar name={a.display_name} />
      <span className={s.who}>
        {title ?? <strong className={s.name}>{a.display_name}</strong>}
        <span className="muted">{[facts(a), state].filter(Boolean).join(" · ")}</span>
      </span>
    </span>
  );
}

const TONE = { ENFORCED: "ok", PREPARED: "info", SCHEDULED: "info", ROLE_INACTIVE: "warn", SCOPE_UNAVAILABLE: "warn" } as const;
/** A grant's state: counts now, waits for go-live, starts later, or counts for nothing because its role was retired. */
export const EnforcementChip = ({ e }: { e: string }) => <Chip tone={TONE[e as keyof typeof TONE] ?? "neutral"}>{enforcementText(e)}</Chip>;
