// SPDX-License-Identifier: LicenseRef-Proprietary
/** Threshold above which a list choice switches to a server-side search (PATTERN-PICK-SIZE). */
export const PICK_SIZE_THRESHOLD = 15;
export const shouldServerSearch = (count: number) => count > PICK_SIZE_THRESHOLD;
