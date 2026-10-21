/** The change classes whose approval a tenant may route (settings keys `approval.policy.<class>`, decisions #26). */
export type ApprovalClass = "exit" | "org_structure";

/** Whether the settings in force route `cls` through a second person (pilot default `none`). */
export const policyRouted = (items: readonly { key: string; value?: unknown }[] | undefined, cls: ApprovalClass) =>
  items?.find((x) => x.key === `approval.policy.${cls}`)?.value === "route";

/**
 * The exit HQ tier's second-person rule as the server applies it: under `route` the HR confirmer may not also
 * confirm for HQ (the ops account may, after a passkey step-up, which no screen offers yet); under `none` the HR
 * confirmer finishes the tier.
 */
export const hqNeedsSomeoneElse = (routed: boolean, hrConfirmedBy: string | null | undefined, me: string | undefined) =>
  routed && hrConfirmedBy != null && hrConfirmedBy === me;
