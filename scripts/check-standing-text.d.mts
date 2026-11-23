// SPDX-License-Identifier: LicenseRef-Proprietary
export function inScope(file: string): boolean;
export function filesIn(dir: string): string[];
export function blocks(file: string, source: string): number;
export function screenCounts(sources: Record<string, string>, newScreens?: Record<string, number>): Record<string, number>;
export function ratchet(
  now: Record<string, number>,
  baseline: Record<string, number>,
  previous?: Record<string, number>,
  newScreens?: Record<string, number>,
): string[];
