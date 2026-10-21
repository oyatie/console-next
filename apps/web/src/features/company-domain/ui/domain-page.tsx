import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { PageHead } from "../../../ui/page-head/page-head";
import { QueryState } from "../../../lib/react/query-state";
import { get } from "../../../lib/query";
import { CompanyDomain } from "./company-domain";

export function CompanyDomainPage() {
  const me = useQuery({ ...get("/api/v1/users/me"), staleTime: 0 });
  return <div className="page">
    <PageHead title={t("account.domain.title")} />
    <QueryState q={me}>{(u) => <CompanyDomain signInId={u.sign_in_id} ops={u.is_tenant_ops} />}</QueryState>
  </div>;
}
