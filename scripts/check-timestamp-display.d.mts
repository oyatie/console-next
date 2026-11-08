// SPDX-License-Identifier: LicenseRef-Proprietary
export const timestampContract: unknown;
export function timestampProblems(spec: unknown, schema: unknown, value: unknown, location?: string): string[];
export function responseTimestampProblems(spec: unknown, route: string, method: string, status: number, body: unknown): string[];
export function checkTimestampContract(spec?: unknown): string[];
