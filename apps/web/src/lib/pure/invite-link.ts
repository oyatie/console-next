// SPDX-License-Identifier: LicenseRef-Proprietary

/** Builds an invite URL keeping the one-time code strictly in the client-side `#otp=` fragment. */
export const buildInviteUrl = (origin: string, otp: string): string =>
  `${origin.replace(/\/+$/, "")}/login#otp=${encodeURIComponent(otp.trim())}`;
