// SPDX-License-Identifier: LicenseRef-Proprietary
import { InboxPage } from "../features/home/ui/inbox-page";
import { inboxAction } from "./inbox-action";

export { SelfBindingReview } from "../features/people/ui/self-binding-review";

export function InboxScreen() {
  return <InboxPage action={inboxAction} />;
}
