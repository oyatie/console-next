// SPDX-License-Identifier: LicenseRef-Proprietary
/** The command-outcome contract accepts 16–200 Unicode characters. */
export function requestKey(value: string): string | undefined {
  const key = value.trim();
  const length = Array.from(key).length;
  return length >= 16 && length <= 200 ? key : undefined;
}
