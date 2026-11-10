// SPDX-License-Identifier: LicenseRef-Proprietary
/** Parse an external destination once; only HTTPS addresses are usable. */
export function externalUrlValue(href: string): URL | null {
  try {
    const value = new URL(href);
    return value.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}
