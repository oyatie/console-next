// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { api, configure, refresh, unwrap } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { COMMAND_NOT_APPLIED, useCommand } from "../apps/web/src/lib/react/command";
import { CommandError } from "../apps/web/src/lib/react/command-error";
import { Button } from "../apps/web/src/ui/button/button";
import "../apps/web/src/app.css";

await loadCatalog("ko");
configure({ baseUrl: location.origin, refresh: { kind: "cookie" }, passkeys: { get: async () => null, create: async () => null } });
await refresh();

function Command() {
  const save = useCommand({
    run: (display_name: string) => unwrap(api.PATCH("/api/v1/users/me", { body: { display_name } })),
    verify: async (name) => {
      const profile = await unwrap(api.GET("/api/v1/users/me"));
      return profile.display_name === name ? profile : COMMAND_NOT_APPLIED;
    },
  });
  return <main>
    <h1>{t("account.name.edit")}</h1>
    <Button disabled={save.isPending} onClick={() => save.mutate("확인한 이름")}>{t("account.name.edit")}</Button>
    <CommandError error={save.error} />
    {save.data && <p role="status">{save.data.display_name}</p>}
  </main>;
}

const router = createRouter({ routeTree: createRootRoute({ component: Command }), history: createMemoryHistory() });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
