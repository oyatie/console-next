// SPDX-License-Identifier: LicenseRef-Proprietary
import { moduleReady, modulesQuery, PERSONAL_LOCATION_MODULE } from "../../../reference/onboarding/api";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { Banknote, CalendarDays, ChevronRight, Clock, FileText, LayoutDashboard, LogOut, ShieldCheck } from "lucide-react";
import { t } from "@console/i18n";
import { fmtMonth } from "@console/i18n/format";
import type { ReadState } from "../../../lib/react/query-view";
import { SupportLookup } from "../../../lib/react/support-lookup";
import { useSidePanel } from "../../../lib/side-panel/use-side-panel";
import { personName } from "../../../reference/person/present";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { KeyValue, StatRow } from "../../../ui/key-value/key-value";
import { PhoneHub } from "../../../ui/patterns/phone-hub";
import type { PhoneHubLinkItem, PhoneHubSection } from "../../../ui/patterns/phone-hub-contract";
import {
  claims,
  meProfileQuery,
  myAccessLogQuery,
  myLeaveSummaryQuery,
  myPayslipDocsQuery,
  signOutHere,
  tenantRecoveryQuery,
  type InboxDocSummary,
  type Me,
} from "../api";
import { payslipMonthSource } from "../domain/profile";
import { ConsentBody } from "./consent-card";
import { MyAccessGrants } from "./my-access";
import { OpsRecoveryBody } from "./ops-recovery-notice";
import { OpsSecurityBody } from "./ops-security-card";
import { usePasskeysContent } from "./use-passkeys-content";
import { ProfileName } from "./profile-name";
import { MyAccessLogBody } from "./me-access-log";
import { MeCertificatesSheet } from "./me-certificates-sheet";
import { HubIdentity } from "./me-identity";
import { MePayslipSheet } from "./me-payslip-sheet";
import { SelfEditableBody } from "./me-self-edit";
import s from "./account.module.css";

function formatPayslipMeta(doc: InboxDocSummary): string {
  const monthSource = payslipMonthSource(doc);
  const period = monthSource ? fmtMonth(monthSource) : doc.title;
  const payDate = doc.payslip_meta?.pay_date;
  return payDate ? t("account.hub.payslipPayDate", { period, date: payDate.slice(5) }) : period;
}

export function MeConsole({
  reads,
  keys,
  me,
  locale,
  experience,
  singleKeys,
  baseline,
}: {
  reads: ReadState;
  keys: UseQueryResult<components["schemas"]["PasskeySummary"][]>;
  me: UseQueryResult<Me>;
  locale: ReactNode;
  experience: ReactNode;
  singleKeys: ReactNode;
  baseline: () => ReactNode;
}) {
  const nav = useNavigate();
  const c = claims();
  const vendor = Boolean(c?.platform);
  const u = me.data;
  const isLinked = !vendor && u?.employee_link_status === "LINKED";

  const [payslipId, setPayslipId] = useState<string | null>(null);
  // The sheet lives in the address, so the phone nav and a shared link open it and Back closes it.
  const sheet = useSidePanel("sheet");
  const meProfile = useQuery({ ...meProfileQuery, enabled: isLinked, retry: false });
  const leave = useQuery({ ...myLeaveSummaryQuery, enabled: isLinked, retry: false });
  const payslips = useQuery({ ...myPayslipDocsQuery, enabled: isLinked, retry: false });
  const accessLog = useQuery({ ...myAccessLogQuery, enabled: isLinked, retry: false });
  const modules = useQuery({ ...modulesQuery, enabled: !vendor });
  const recovery = useQuery({ ...tenantRecoveryQuery, enabled: !vendor });
  const passkeysUI = usePasskeysContent({
    ops: vendor ? false : u?.is_tenant_ops,
    passkeys: keys,
    compact: true,
  });

  const latestPayslip = payslips.data?.items[0];
  const remainingLeave = leave.data?.balance?.remaining_units;
  const links: PhoneHubLinkItem[] = isLinked
    ? [
        ...(u?.tenant?.phase === "OPERATING" ? [{
          key: "desk", icon: <LayoutDashboard size={20} aria-hidden="true" />,
          label: t("shell.link.meDesk"), href: "/me/desk",
        } satisfies PhoneHubLinkItem] : []),
        {
          key: "leave",
          icon: <CalendarDays size={20} aria-hidden="true" />,
          label: t("account.hub.leave"),
          meta: remainingLeave != null ? t("account.hub.leaveRemaining", { days: Number(remainingLeave) }) : undefined,
          href: "/leave",
        },
        {
          key: "me-attendance",
          icon: <Clock size={20} aria-hidden="true" />,
          label: t("account.hub.attendance"),
          meta: t("account.hub.attendanceMeta"),
          href: "/me/attendance",
        },
        {
          key: "payslip",
          icon: <Banknote size={20} aria-hidden="true" />,
          label: t("account.hub.payslip"),
          meta: latestPayslip ? formatPayslipMeta(latestPayslip) : undefined,
          href: latestPayslip ? undefined : "/payslips",
          onPress: latestPayslip ? () => setPayslipId(latestPayslip.id) : undefined,
        },
        {
          key: "certificates",
          icon: <FileText size={20} aria-hidden="true" />,
          label: t("account.hub.certificates"),
          meta: t("account.hub.certificatesMeta"),
          onPress: () => sheet.select("certificates"),
        },
      ]
    : [];

  const hireDate = u?.employee_hire_date ?? meProfile.data?.hire_date;
  const stats =
    isLinked && u ? (
      <StatRow
        label={t("shell.profile")}
        items={[
          { key: "empNo", label: t("account.stat.employeeNumber"), value: u.employee_number ?? t("person.field.notSet") },
          { key: "unit", label: t("account.field.unit"), value: u.employee_org_unit ?? t("person.field.notSet") },
          { key: "hireDate", label: t("account.stat.hireDate"), value: hireDate ?? t("person.field.notSet") },
        ]}
      />
    ) : undefined;

  const accountItems = [
    {
      key: "name",
      label: t("account.field.name"),
      value: (
        <div className="row">
          {personName(u?.display_name ?? c?.name, t(vendor ? "account.name.unset.operator" : "account.name.unset"))}
          {u && <ProfileName current={u.display_name} />}
          {u?.is_tenant_ops && <Chip tone="info">{t("account.field.ops")}</Chip>}
        </div>
      ),
    },
    ...(vendor ? [] : [{ key: "history", label: t("requestOutcome.title"), value: <Link to="/requests">{t("requestOutcome.myHistory.title")}</Link> }]),
    ...(vendor ? [] : [{ key: "signInId", label: t("account.field.signInId"), value: <bdi className="code">{u?.sign_in_id ?? "—"}</bdi> }]),
    ...(vendor ? [] : [{ key: "domain", label: t("account.domain.title"), value: <Link to="/settings/company-domain" className={s.plainLink}>{u?.sign_in_id?.split("@")[1] ?? "—"}</Link> }]),
    ...(vendor || isLinked ? [] : [{ key: "unit", label: t("account.field.unit"), value: <bdi className="muted">{t("account.field.unlinked")}</bdi> }]),
    ...(vendor ? [{ key: "roles", label: t("account.field.roles"), value: <Chip>{t("account.field.platform")}</Chip> }] : []),
    { key: "locale", label: <label htmlFor="acct-locale">{t("shell.locale")}</label>, value: locale },
    { key: "theme", label: t("account.field.theme"), value: <bdi className="muted">{t("account.field.theme.where")}</bdi> },
    { key: "experience", label: <label htmlFor="account-experience">{t("account.experience")}</label>, value: experience },
    { key: "shortcuts", label: t("account.field.shortcuts"), value: singleKeys },
  ];

  const sections: PhoneHubSection[] = [
    ...(isLinked && u && u.employee_id
      ? [
          {
            key: "self-edit",
            title: t("account.selfEdit.title"),
            children: <SelfEditableBody employeeId={u.employee_id} profileQuery={meProfile} />,
          },
          {
            key: "access-log",
            title: t("account.accessLog.title"),
            action: <Link to="/account/privacy" className={`${s.actionBtn} ${s.plainLink} t-primary`}>{t("account.accessLog.viewAll")}</Link>,
            children: <div className={s.pad}><MyAccessLogBody q={accessLog} /></div>,
          },
        ]
      : []),
    {
      key: "profile",
      title: t("account.profile"),
      action: (
        <Button size="sm" variant="secondary" className={s.actionBtn} onClick={async () => (await signOutHere(), nav({ to: "/login" }))}>
          <LogOut size={16} aria-hidden /> {t("account.logout.here")}
        </Button>
      ),
      children: <div className={s.pad}><KeyValue items={accountItems} /></div>,
    },
    { key: "passkeys", title: t("account.passkeys"), titleId: "acct-passkeys", action: passkeysUI.addButton, children: passkeysUI.body },
    { key: "consent", title: t("account.consent.title"), children: <div className={s.pad}><ConsentBody /></div> },
    ...(!vendor
      ? [{
          key: "privacy",
          title: t("account.privacy.section"),
          children: (
            <div className={s.pad}>
              <Link to="/account/privacy" className={`${s.privacyLink} ${s.plainLink}`}>
                <ShieldCheck size={18} aria-hidden="true" className="t-primary" />
                <bdi className={s.privacyLabel}>{t("account.privacy.title")}</bdi>
                <ChevronRight size={16} aria-hidden="true" className="muted" />
              </Link>
              {moduleReady(modules.data, PERSONAL_LOCATION_MODULE) && <Link to="/account/location" className={`${s.privacyLink} ${s.plainLink}`}>
                <ShieldCheck size={18} aria-hidden="true" className="t-primary" />
                <bdi className={s.privacyLabel}>{t("account.location.link")}</bdi>
                <ChevronRight size={16} aria-hidden="true" className="muted" />
              </Link>}
            </div>
          ),
        }]
      : []),
    ...(!vendor && u?.is_tenant_ops
      ? [{ key: "ops-security", title: t("account.opsSecurity.title"), titleId: "account-ops-security", children: <div className={s.pad}><OpsSecurityBody myId={u.id} /></div> }]
      : []),
    ...(!vendor && recovery.data?.request
      ? [{ key: "ops-recovery", title: t("opsRecovery.title"), titleId: "account-ops-recovery", children: <div className={s.pad}><OpsRecoveryBody /></div> }]
      : []),
    ...(!vendor ? [{ key: "access", title: t("account.access.title"), titleId: "acct-access", children: <div className={s.pad}><MyAccessGrants /></div> }] : []),
    ...(vendor || u?.is_tenant_ops ? [{ key: "support", title: t("tenants.supportLookup.title"), children: <div className={s.pad}><SupportLookup /></div> }] : []),
  ];

  return (
    <PhoneHub
      q={reads}
      head={{ title: t("shell.profile"), titleId: "account-title" }}
      identity={<HubIdentity vendor={vendor} isLinked={isLinked} u={u} profile={meProfile.data} fallbackName={c?.name} />}
      stats={stats}
      links={links}
      renderLink={(item, content, className) =>
        item.href ? <Link to={item.href} className={className}>{content}</Link>
          : <Button variant="ghost" className={className} onClick={item.onPress}>{content}</Button>
      }
      sections={sections}
      overlays={
        <>
          <MePayslipSheet docId={payslipId} onClose={() => setPayslipId(null)} />
          {isLinked && (
            <MeCertificatesSheet
              open={sheet.selected === "certificates"}
              employmentStatus={u?.employee_employment_status ?? meProfile.data?.employment_status}
              onClose={sheet.close}
            />
          )}
        </>
      }
      baseline={baseline}
    />
  );
}
