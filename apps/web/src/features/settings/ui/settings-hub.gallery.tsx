// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { get } from "../../../lib/query";
import { t } from "@console/i18n";
import { Section } from "../../../gallery/Section";
import { settingsQuery } from "../../../reference/settings/api";
import { SETTINGS_VIEWS } from "../../../shell/settings-views";
import { SettingsHubView } from "./settings-hub";

export const order = 129;
export default function SettingsHubGallery() {
  const [client] = useState(() => {
    const query = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, retryOnMount: false } } });
    query.setQueryData(get("/api/v1/users/me").queryKey, { sign_in_id: "operator@current.test" });
    query.setQueryData(settingsQuery.queryKey, { can_change: false, items: [] });
    const values = [{ pending_domain: "example.test" }, [{ scope_kind: "TENANT", next_number: "E-0012" }], { items: [] }];
    values.forEach((value, index) => query.setQueryData(SETTINGS_VIEWS[index]!.summary.queryKey, value));
    return query;
  });
  const rows = SETTINGS_VIEWS.map(row => row.to === "/people/period-locks"
    ? { ...row, summary: { ...row.summary, queryFn: async () => { throw new Error("unavailable"); } } } : row);
  return <Section title={t("shell.link.settings")}><div data-settings-gallery>
    <QueryClientProvider client={client}><SettingsHubView rows={rows} /></QueryClientProvider>
  </div></Section>;
}
