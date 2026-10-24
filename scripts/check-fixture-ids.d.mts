// SPDX-License-Identifier: LicenseRef-Proprietary
export const syntheticRanges: { phoneMiddle: string[]; businessPrefix: string };
export function syntheticPhone(index: number): string;
export function syntheticRrn(body: string): string;
export function rrnChecksumValid(digits: string): boolean;
export function strippedZeroRrn(whole: string): string | null;
export function validRrnLines(text: string): number[];
