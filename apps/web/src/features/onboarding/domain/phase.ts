import type { components } from "@console/api/schema";

type Schema = components["schemas"];

/** Both access projections describe what the signed-in account currently holds. */
export function canReadSetupChecklist(access: Schema["AccessEffective"] | Schema["MeAuthzResponse"] | undefined) {
  if (!access) return false;
  if ("capabilities" in access) return access.capabilities.some(c => c.permission !== "request_only");
  return access.is_ops || access.entries.some(entry => entry.enforcement === "ENFORCED");
}

/** Missing or invalid settings never invent a receipt window. */
export function receiptDuration(items: readonly { key: string; value?: unknown }[] | undefined) {
  const days = items?.find(item => item.key === "onboarding.receipt_days")?.value;
  return typeof days === "number" && Number.isFinite(days) && days > 0 ? days * 86400000 : 0;
}

/** Setup needs attention; operations only have a receipt within the configured elapsed window. */
export function phaseBand(phase: string, goLiveAt: string | null | undefined, now: number, duration: number) {
  if (phase === "SETUP") return "setup";
  if (phase !== "OPERATING" || !goLiveAt) return null;
  // OPERATING is authoritative even when the server clock is ahead of this device.
  const elapsed = Math.max(0, now - Date.parse(goLiveAt));
  return elapsed >= 0 && elapsed < duration ? "started" : null;
}
