// SPDX-License-Identifier: LicenseRef-Proprietary
export interface ThemeTokenSet {
  light: Record<string, string>;
  dark: Record<string, string>;
  problems: string[];
}

export function experienceFiles(tokensFile: string): string[];
export function themeTokens(css: string): ThemeTokenSet;
export function experienceThemes(
  base: { light: Record<string, string>; dark: Record<string, string> },
  own: { light: Record<string, string>; dark: Record<string, string> },
): { light: Record<string, string>; dark: Record<string, string> };
export function contrastRatio(a: string, b: string): number;
export function meetsContrast(ratio: number, kind: "text" | "non-text"): boolean;
export function checkContrast(css: string): { problems: string[]; checks: number };
export function checkTokens(file: string): { problems: string[]; checks: number };
