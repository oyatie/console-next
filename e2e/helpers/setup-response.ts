// SPDX-License-Identifier: LicenseRef-Proprietary
type SetupResponse = { status(): number; ok(): boolean; json(): Promise<unknown> };
type RefusalPart = { code?: unknown; field?: unknown };
type RefusalBody = RefusalPart & { errors?: unknown; error?: unknown };

const safeLabel = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9_.\[\]-]+$/.test(value) ? value : "unknown";

async function refusalCodeAndField(response: SetupResponse): Promise<string> {
  try {
    const body = (await response.json()) as RefusalBody;
    const errors = Array.isArray(body.errors) ? body.errors : [];
    const issue = errors.find((entry) => entry && typeof entry === "object") as RefusalPart | undefined;
    const error = body.error && typeof body.error === "object" ? (body.error as RefusalPart) : undefined;
    const code = issue?.code ?? error?.code ?? body.code;
    const field = issue?.field ?? error?.field ?? body.field;
    return `${safeLabel(code)}@${safeLabel(field)}`;
  } catch {
    return "unknown@unknown";
  }
}

export async function expectStatus(response: Promise<SetupResponse>, expected: number, operation: string) {
  const result = await response;
  const actual = result.status();
  if (actual !== expected) {
    throw new Error(`${operation}: expected HTTP ${expected}, got ${actual}; refusal=${await refusalCodeAndField(result)}`);
  }
}

export async function expectSuccess(response: Promise<SetupResponse>, operation: string) {
  const result = await response;
  if (!result.ok()) {
    throw new Error(`${operation}: expected success, got HTTP ${result.status()}; refusal=${await refusalCodeAndField(result)}`);
  }
}
