// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { chunk } from "../../../lib/chunk-guard";
import { get } from "../../../lib/query";
import { QueryState } from "../../../lib/react/query-state";
import { PageHead } from "../../../ui/page-head/page-head";
import { SettingsPattern } from "../../../ui/patterns/settings";
import { CompanyDomain } from "./company-domain";

const CompanyDomainConsole = lazy(() =>
  chunk(import("./company-domain-console")).then((m) => ({ default: m.CompanyDomainConsole })),
);

export function CompanyDomainPage() {
  const me = useQuery({ ...get("/api/v1/users/me"), staleTime: 0 });
  return (
    <SettingsPattern
      q={me}
      head={{ title: t("account.domain.title") }}
      panel={
        me.data ? (
          <Suspense fallback={null}>
            <CompanyDomainConsole signInId={me.data.sign_in_id} ops={me.data.is_tenant_ops} />
          </Suspense>
        ) : null
      }
      baseline={() => (
        <div className="page">
          <PageHead title={t("account.domain.title")} />
          <QueryState q={me} layout="record">
            {(u) => <CompanyDomain signInId={u.sign_in_id} ops={u.is_tenant_ops} />}
          </QueryState>
        </div>
      )}
    />
  );
}
