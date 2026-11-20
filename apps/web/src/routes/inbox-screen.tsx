// SPDX-License-Identifier: LicenseRef-Proprietary
import { InboxPage } from "../features/home/ui/inbox-page";
import {
  consoleInlineRowAction,
  consoleRecordBody,
  consoleRecordFooter,
  inboxAction,
} from "./inbox-action";
import { readRequirement } from "./route-reads";

const ORG_NEED = readRequirement("/org");

export function InboxScreen() {
  return (
    <InboxPage
      action={inboxAction}
      inlineRowAction={consoleInlineRowAction}
      recordBody={consoleRecordBody}
      recordFooter={consoleRecordFooter}
      orgNeed={ORG_NEED}
    />
  );
}
