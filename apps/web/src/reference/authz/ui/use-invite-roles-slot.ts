// SPDX-License-Identifier: LicenseRef-Proprietary
import { createContext, useContext, type ReactElement, type ReactNode } from "react";

export type InviteWithRolesSlotProps = {
  accountFields: ReactNode;
  displayName: string;
  employeeId?: string;
  normalizedLogin: string | null;
  accountBlockedWhy: string | null;
  onTriedAccount: () => void;
  onFocusInvalid: () => void;
  onClose: () => void;
  onIssued: (r: {
    user_id: string;
    userId: string;
    name: string;
    signInId?: string | null;
    otp: string;
    expires_at: string;
    grantedCount?: number;
  }) => void;
};

export const InviteWithRolesSlot = createContext<((props: InviteWithRolesSlotProps) => ReactElement) | null>(null);

export const useInviteWithRolesSlot = () => useContext(InviteWithRolesSlot);
