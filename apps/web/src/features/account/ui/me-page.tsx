import { useContext, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { SupportLookup } from "../../../lib/react/support-lookup";
import { PageHead } from "../../../ui/page-head/page-head";
import { PagePhoneHeader } from "../../../ui/page/page-scope";
import { QueryState } from "../../../lib/react/query-state";
import { readGroup, type ReadState } from "../../../lib/react/query-view";
import { claims, meQuery, operatorMeQuery, passkeysQuery, type Me } from "../api";
import { OpsRecoveryNotice } from "./ops-recovery-notice";
import { OpsSecurityCard } from "./ops-security-card";
import { ConsentCard } from "./consent-card";
import { MyAccessCard } from "./my-access";
import { PasskeysCard } from "./passkeys-card";
import { ProfileCard } from "./profile-card";
import { MeConsole } from "./me-console";
import s from "./account.module.css";

function LegacyMePage({
  vendor,
  shellOwnsH1,
  reads,
  keys,
  me,
  locale,
  experience,
  singleKeys,
}: {
  vendor: boolean;
  shellOwnsH1: boolean;
  reads: ReadState;
  keys: UseQueryResult<components["schemas"]["PasskeySummary"][]>;
  me: UseQueryResult<Me>;
  locale: ReactNode;
  experience: ReactNode;
  singleKeys: ReactNode;
}) {
  return (
    <div className={`page ${s.column}`}>
      {!shellOwnsH1 && <PageHead title={t("account.title")} />}
      <QueryState q={reads} layout="record">{() => <>
          <ProfileCard locale={locale} experience={experience} singleKeys={singleKeys} me={me} />
          <PasskeysCard ops={vendor ? false : me.data?.is_tenant_ops} passkeys={keys} />
          <ConsentCard />
          {!vendor && <div><Link to="/account/privacy">{t("account.privacy.title")}</Link></div>}
          {!vendor && me.data?.is_tenant_ops && <OpsSecurityCard myId={me.data.id} />}
          {!vendor && <OpsRecoveryNotice />}
          {!vendor && <MyAccessCard />}
          {(vendor || me.data?.is_tenant_ops) && <SupportLookup />}
      </>}</QueryState>
    </div>
  );
}

/**
 * My account, for both tiers: who I am, my passkeys, what I agreed to, and (tenant accounts) what I may do. The shell controls are
 * handed in by the route's composition file.
 */
export function MePage({ locale, experience, singleKeys }: { locale: ReactNode; experience: ReactNode; singleKeys: ReactNode }) {
  const vendor = Boolean(claims()?.platform);
  const { shellOwnsH1 } = useContext(PagePhoneHeader);
  // Wait for the passkey warning's facts so it never pushes the cards below it down after they are drawn.
  const keys = useQuery(passkeysQuery);
  const me = useQuery<Me>(vendor ? operatorMeQuery : meQuery);
  const reads = readGroup([keys, me]);
  return (
    <MeConsole
      reads={reads}
      keys={keys}
      me={me}
      locale={locale}
      experience={experience}
      singleKeys={singleKeys}
      baseline={() => (
        <LegacyMePage
          vendor={vendor}
          shellOwnsH1={shellOwnsH1}
          reads={reads}
          keys={keys}
          me={me}
          locale={locale}
          experience={experience}
          singleKeys={singleKeys}
        />
      )}
    />
  );
}
