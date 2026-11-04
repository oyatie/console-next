// SPDX-License-Identifier: LicenseRef-Proprietary
import { useContext, type ComponentProps, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { Page } from "../../ui/page/page";
import { InboxQueue } from "./ui/inbox-queue";
import { meQuery } from "./api";
import { PagePhase } from "../../ui/page/page-scope";
import css from "./ui/home.module.css";

export function Home({ receipt, ...props }: Pick<NonNullable<ComponentProps<typeof InboxQueue>>, "setup" | "setupPending" | "action"> & { receipt?: ReactNode } = {}) {
  const me = useQuery(meQuery);
  const phase = useContext(PagePhase);
  return <PagePhase value={<div className={`${css.phase} t-xs`}>{phase}</div>}><Page floorplan="P-03" head={{ title: me.data ? t("home.greeting", { name: me.data.display_name }) : t("home.title"), titleId: "home-title" }}>
    {receipt}
    <InboxQueue {...props} preview />
  </Page></PagePhase>;
}
