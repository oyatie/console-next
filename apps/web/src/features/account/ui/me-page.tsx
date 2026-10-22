import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { SupportLookup } from "../../../lib/react/support-lookup";
import { PageHead } from "../../../ui/page-head/page-head";
import { Skeleton } from "../../../ui/skeleton/skeleton";
import { claims, meQuery, passkeysQuery } from "../api";
import { OpsRecoveryNotice } from "./ops-recovery-notice";
import { ConsentCard } from "./consent-card";
import { MyAccessCard } from "./my-access";
import { PasskeysCard } from "./passkeys-card";
import { ProfileCard } from "./profile-card";
import s from "./account.module.css";

/**
 * My account, for both tiers: who I am, my passkeys, what I agreed to, and (tenant accounts) what I may do. `locale` is the shell's
 * language control, handed in by the route's composition file.
 * Extension points (no affordance until the API exists): ESS sections, sessions and sign-in
 * history, the location-consent link.
 */
export function MePage({ locale }: { locale: ReactNode }) {
  const vendor = Boolean(claims()?.platform);
  // Wait for the passkey warning's facts so it never pushes the cards below it down after they are drawn.
  const keys = useQuery(passkeysQuery);
  const me = useQuery({ ...meQuery, enabled: !vendor });
  const waiting = keys.isPending || (!vendor && me.isPending);
  return (
    <div className={`page ${s.column}`}>
      <PageHead title={t("account.title")} />
      {waiting && !keys.isError && !me.isError ? (
        <Skeleton label={t("common.loading")} bones={["title", "row", "row"]} />
      ) : (
        <>
          <ProfileCard locale={locale} me={me} />
          <PasskeysCard ops={vendor ? false : me.data?.is_tenant_ops} passkeys={keys} />
          <ConsentCard />
          {!vendor && <OpsRecoveryNotice />}
          {!vendor && <MyAccessCard />}
          {(vendor || me.data?.is_tenant_ops) && <SupportLookup />}
        </>
      )}
    </div>
  );
}
