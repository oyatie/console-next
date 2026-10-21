// SPDX-License-Identifier: LicenseRef-Proprietary
/** Server-owned reasons: no passkey retry after the credential or account ceased to exist. */
export function sessionRecovery(reason: string | null) {
  switch (reason) {
    case "session_idle_expired": return { message: "idle.reauth.idle", passkey: true } as const;
    case "session_expired": return { message: "idle.reauth.expired", passkey: true } as const;
    case "session_passkey_reset": return { message: "idle.reauth.reset", passkey: false } as const;
    case "session_deactivated": return { message: "idle.reauth.deactivated", passkey: false } as const;
    case "session_signed_out_elsewhere": return { message: "idle.reauth.elsewhere", passkey: true } as const;
    case "session_revoked": return { message: "idle.reauth.admin", passkey: true } as const;
    default: return { message: "idle.reauth.body", passkey: true } as const;
  }
}
