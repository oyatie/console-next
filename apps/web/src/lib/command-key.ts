// SPDX-License-Identifier: LicenseRef-Proprietary
/**
 * Whether this system's keyboard has the Command key. A hint for a chord that takes Command or Control shows ⌘ where
 * this is true and Ctrl elsewhere. A module of its own, so a hint loads no key table with it.
 */
export const hasCommandKey = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
