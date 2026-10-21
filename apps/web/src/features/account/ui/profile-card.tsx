import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { KeyValue } from "../../../ui/key-value/key-value";
import { claims, signOutHere, type Me } from "../api";

/**
 * Who I am. A tenant account adds its employee link from `/users/me`; a vendor (platform token) reads
 * only its token, since that read answers 404 there, and never shows an error for it.
 */
export function ProfileCard({ locale, me }: { locale: ReactNode; me: UseQueryResult<Me> }) {
  const nav = useNavigate();
  const c = claims();
  const vendor = Boolean(c?.platform);
  const u = me.data;
  return (
    <Card
      title={t("account.profile")}
      tools={
        <Button onClick={async () => (await signOutHere(), nav({ to: "/login" }))}>
          <LogOut size={16} aria-hidden /> {t("account.logout.here")}
        </Button>
      }
    >
      <KeyValue
        items={[
          // The ops account is named in the name row, not a row of its own: /users/me lands after the passkeys, and a row
          // appearing then would push the cards below under a pointer already on them (account.spec layout shift).
          { key: "name", label: t("account.field.name"), value: <span className="row">{u?.display_name ?? c?.name ?? "—"}{u?.is_tenant_ops && <Chip tone="info">{t("account.field.ops")}</Chip>}</span> },
          // My sign-in ID (decisions #33): HR changes it, with a reason; the row is there from the first paint.
          ...(vendor ? [] : [{ key: "signInId", label: t("account.field.signInId"), value: <span className="code">{u?.sign_in_id ?? "—"}</span> }]),
          ...(vendor ? [] : [{ key: "domain", label: t("account.domain.title"), value: <Link to="/settings/company-domain">{u?.sign_in_id?.split("@")[1] ?? "—"}</Link> }]),
          ...(vendor ? [] : [{ key: "unit", label: t("account.field.unit"), value: u ? <Unit u={u} /> : <span className="muted">{t(me.error ? "common.loadFailed.title" : "common.loading")}</span> }]),
          // No preset roles (governance-01, company-17): no title row; ops is named as such, access is its own card.
          ...(vendor ? [{ key: "roles", label: t("account.field.roles"), value: <Chip>{t("account.field.platform")}</Chip> }] : []),
          { key: "locale", label: <label htmlFor="acct-locale">{t("shell.locale")}</label>, value: locale },
          { key: "theme", label: t("account.field.theme"), value: <span className="muted">{t("account.field.theme.where")}</span> },
        ]}
      />
    </Card>
  );
}

/** The employee record this account is linked to, as unit · position · number. */
function Unit({ u }: { u: Me }) {
  if (u.employee_link_status !== "LINKED") return <span className="muted">{t("account.field.unlinked")}</span>;
  return <>{[u.employee_org_unit, u.employee_position, u.employee_number].filter(Boolean).join(" · ") || "—"}</>;
}
