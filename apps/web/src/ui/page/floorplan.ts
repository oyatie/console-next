// SPDX-License-Identifier: LicenseRef-Proprietary
export const FLOORPLANS = ["P-01", "P-02", "P-03", "P-04", "P-05", "canvas"] as const;
export type Floorplan = (typeof FLOORPLANS)[number];
