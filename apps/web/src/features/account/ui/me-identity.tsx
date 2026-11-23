// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { personName } from "../../../reference/person/present";
import { Chip } from "../../../ui/chip";
import type { Me, MeProfile } from "../api";
import { employmentStatusBadge, formatEmploymentGradeRole } from "../domain/profile";
import s from "./account.module.css";

/** Identity header band for PhoneHub `/account`: name, employment status chip, and deduplicated grade/role. */
export function HubIdentity({
  vendor,
  isLinked,
  u,
  profile,
  fallbackName,
}: {
  vendor: boolean;
  isLinked: boolean;
  u?: Me;
  profile?: MeProfile;
  fallbackName?: string | null;
}) {
  if (!u) return undefined;
  const status = isLinked
    ? employmentStatusBadge(u.employee_employment_status ?? profile?.employment_status)
    : null;
  const gradeRole = isLinked
    ? formatEmploymentGradeRole(
        u.employee_grade ?? profile?.grade,
        u.employee_position ?? profile?.position,
      )
    : null;

  return (
    <div>
      <div className={s.identityHead}>
        <strong className="t-xl t-strong">
          {isLinked
            ? (u.employee_name ?? personName(u.display_name, t("account.name.unset")))
            : personName(
                u.display_name ?? fallbackName,
                t(vendor ? "account.name.unset.operator" : "account.name.unset"),
              )}
        </strong>
        {status && (
          <Chip tone={status.tone} className={s.actionBtn}>
            {t("account.status.withDot", { status: t(`enum.employeeStatus.${status.code}`) })}
          </Chip>
        )}
        {gradeRole && <div className="t-sm muted">{gradeRole}</div>}
        {!vendor && !isLinked && (
          <Chip tone="neutral" className={s.actionBtn}>
            {t("account.status.unlinked")}
          </Chip>
        )}
        {vendor && (
          <Chip tone="outline" className={s.actionBtn}>
            {t("account.field.platform")}
          </Chip>
        )}
        {u.is_tenant_ops && (
          <Chip tone="info" className={s.actionBtn}>
            {t("account.field.ops")}
          </Chip>
        )}
      </div>
      {!isLinked && !vendor && u.tenant?.name ? (
        <div className="t-sm muted">{u.tenant.name}</div>
      ) : null}
    </div>
  );
}
