// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense } from "react";
import { chunk } from "../lib/chunk-guard";
import { PeopleRoute } from "../features/people/ui/people-route";
import { InviteWithRolesSlot, type InviteWithRolesSlotProps } from "../reference/authz/ui/use-invite-roles-slot";

const InviteWithRolesSheet = lazy(() =>
  chunk(import("../features/access/ui/account-invite-roles")).then((m) => ({ default: m.InviteWithRolesSheet })),
);

const renderInviteWithRoles = (props: InviteWithRolesSlotProps) => (
  <Suspense fallback={null}>
    <InviteWithRolesSheet {...props} />
  </Suspense>
);

export function PeopleScreen() {
  return (
    <InviteWithRolesSlot.Provider value={renderInviteWithRoles}>
      <PeopleRoute />
    </InviteWithRolesSlot.Provider>
  );
}
