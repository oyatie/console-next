// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, refresh, unwrap } from "@console/api";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { COMMAND_NOT_APPLIED, useCommand } from "../../lib/react/command";
import { CommandError } from "../../lib/react/command-error";
import { Button } from "../../ui/button/button";
import { Section } from "../Section";

export const order = 41;

export default function Command() {
  const save = useCommand({
    run: async (display_name: string) => {
      // The gallery does not run the signed-in route guard.
      await refresh();
      return unwrap(api.PATCH("/api/v1/users/me", { body: { display_name } }));
    },
    verify: async (name) => {
      const profile = await unwrap(api.GET("/api/v1/users/me"));
      return profile.display_name === name ? profile : COMMAND_NOT_APPLIED;
    },
  });
  return <Section title={t("account.name.edit")}>
    <Button disabled={save.isPending} onClick={() => save.mutate(tg("sample.person", { n: 1 }))}>{t("account.name.edit")}</Button>
    <CommandError error={save.error} />
    {save.data && <p role="status">{save.data.display_name}</p>}
  </Section>;
}
