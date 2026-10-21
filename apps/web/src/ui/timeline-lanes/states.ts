export const timelineStates = ["changed", "corrected", "withdrawn", "scheduled", "schedule_cancelled", "effectuated", "restricted", "operator", "emergency", "read", "destroyed"] as const;
export type TimelineState = typeof timelineStates[number];
export type ActorKind = "TENANT_USER" | "OPS_ACCOUNT" | "GROUP_ADMIN" | "SUPPORT_OPERATOR" | "SYSTEM";
