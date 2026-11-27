// SPDX-License-Identifier: LicenseRef-Proprietary
import { useContext, type ComponentProps, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { Page } from "../../ui/page/page";
import { meQuery } from "./api";
import { InboxQueue } from "./ui/inbox-queue";
import { InboxRead } from "./ui/inbox-read";
import { InboxReadContext } from "./ui/use-inbox-read";
import { WorklistConsole, type WorklistConsoleProps } from "./ui/worklist-console";

type HomeProps = Pick<NonNullable<ComponentProps<typeof InboxQueue>>, "setup" | "setupPending" | "action"> &
  Pick<
    WorklistConsoleProps,
    "inlineRowAction" | "recordBody" | "recordFooter" | "orgNeed" | "canOrgStructure"
  > & { receipt?: ReactNode };

export function Home({
  receipt,
  inlineRowAction,
  recordBody,
  recordFooter,
  orgNeed,
  canOrgStructure,
  ...props
}: HomeProps = {}) {
  const me = useQuery(meQuery);
  const read = useContext(InboxReadContext);
  const content = (
    <WorklistConsole
      mode="home"
      title={t("home.inbox.title")}
      titleId="home-title"
      setup={props.setup}
      setupPending={props.setupPending}
      receipt={receipt}
      action={props.action}
      inlineRowAction={inlineRowAction}
      recordBody={recordBody}
      recordFooter={recordFooter}
      orgNeed={orgNeed}
      canOrgStructure={canOrgStructure}
      baseline={() => (
        <Page floorplan="P-03" head={{ title: t("home.inbox.title"), titleId: "home-title", sub: me.data ? t("home.greeting", { name: me.data.display_name }) : <span aria-hidden="true">{"\u00a0"}</span> }}>
          {receipt}
          <InboxQueue {...props} preview />
        </Page>
      )}
    />
  );
  return read ? content : <InboxRead preview>{content}</InboxRead>;
}
