import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { Avatar } from "../../../ui/avatar/avatar";
import { Chip } from "../../../ui/chip";
import type { Account } from "../api";
import { enforcementText } from "../present";
import { personLabel, type PersonIdentity } from "../../../reference/person/present";
import { PersonLabel } from "../../../reference/person/ui/person-label";
import s from "./access.module.css";

/**
 * An account as every access screen names it: the name exactly as written, then employee number and placement, so two people with one
 * name are told apart (decision #25). The RRN is never shown or sent here.
 */
export function AccountText({ a, peers }: { a: Account; peers?: readonly PersonIdentity[] }) {
  return (
    <span>
      <PersonLabel person={a} peers={peers} />
      {!a.has_passkey && <span className="muted"> · {t("access.account.noPasskey")}</span>}
    </span>
  );
}

/** A person at the head of a sheet or page (mockups M4, M6): initial, name, then employee number, placement and whether they can sign in. */
export function PersonHead({ a, ops, title }: { a: Account; ops?: boolean; title?: ReactNode }) {
  const label = personLabel(a);
  const state = ops ? t("access.account.ops") : t(a.has_passkey ? "access.account.passkey" : "access.account.noPasskey");
  return (
    <span className={s.person}>
      <Avatar name={label.name} />
      <span className={s.who}>
        {title ?? <strong className={s.name}>{label.name}</strong>}
        <span className="muted">{[label.detail, state].filter(Boolean).join(" · ")}</span>
      </span>
    </span>
  );
}

const TONE = { ENFORCED: "ok", PREPARED: "info", SCHEDULED: "info", ROLE_INACTIVE: "warn", SCOPE_UNAVAILABLE: "warn" } as const;
/** A grant's state: counts now, waits for go-live, starts later, or counts for nothing because its role was retired. */
export const EnforcementChip = ({ e }: { e: string }) => <Chip tone={TONE[e as keyof typeof TONE] ?? "neutral"}>{enforcementText(e)}</Chip>;
