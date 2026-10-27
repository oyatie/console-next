// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { Page } from "../../ui/page/page";
import { InboxQueue } from "./ui/inbox-queue";
import { meQuery } from "./api";

export function Home(props: Pick<NonNullable<ComponentProps<typeof InboxQueue>>, "setup" | "setupPending" | "action"> = {}) {
  const me = useQuery(meQuery);
  return <Page floorplan="dashboard" head={{ title: me.data ? t("home.greeting", { name: me.data.display_name }) : t("home.title"), titleId: "home-title" }}>
    <InboxQueue {...props} preview />
  </Page>;
}
