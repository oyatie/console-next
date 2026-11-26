// SPDX-License-Identifier: LicenseRef-Proprietary
export interface CssChildNode {
  type: string;
  prop?: string;
  value?: string;
}

export interface CssRuleNode {
  selector: string;
  nodes?: CssChildNode[];
}

export interface ParsedCssRoot {
  walkRules(visitor: (rule: CssRuleNode) => void): void;
  walkDecls(visitor: (decl: { prop: string; value: string; remove(): void }) => void): void;
  toString(): string;
}

export function parseCss(css: string, from: string): ParsedCssRoot;
export function decodeIdent(raw: string): string;
export function context(node: unknown): { selectors: string[]; media: string[]; hasRule: boolean; otherAt: boolean };
export function rootDeclaration(decl: unknown): boolean;
export function literalColour(value: string): boolean;
export function experienceBlocks(
  css: string,
  id: string,
  baseDark?: Set<string>,
  file?: string,
): { light: Record<string, string>; dark: Record<string, string>; problems: string[] };
export function brokenRefs(
  sources: Record<string, string>,
  sheets: Record<string, string>,
  tokensFile: string,
): string[];
