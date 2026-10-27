// SPDX-License-Identifier: LicenseRef-Proprietary
export const trailGroup = (kind: string) => kind === "FIL" ? "filing" : kind === "PAY" ? "payment" : kind === "ACC" ? "access" : kind === "BACK" ? "return" : "documents";
