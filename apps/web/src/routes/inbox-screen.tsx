// SPDX-License-Identifier: LicenseRef-Proprietary
import { InboxPage } from "../features/home/ui/inbox-page";
import { inboxAction } from "./inbox-action";

export function InboxScreen() {
  return <InboxPage action={inboxAction} />;
}
