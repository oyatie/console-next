// SPDX-License-Identifier: LicenseRef-Proprietary
/** A missing workplace on either side is a plain transfer, as recorded by the server. */
export const moveKind = (from: string | null | undefined, to: string | null | undefined): "TRANSFER" | "relocate" =>
  from && to && from !== to ? "relocate" : "TRANSFER";
