// SPDX-License-Identifier: LicenseRef-Proprietary
export { bootEn } from "./boot-en";
export { bootKo } from "./boot-ko";
export type BootMessageId = keyof typeof import("./boot-en").bootEn;
