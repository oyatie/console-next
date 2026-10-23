// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";

/** Action nouns and verbs are catalog data; screens describe intent, never build frame copy. */
const ACTION_KINDS = {
  orgDetails: ["composer.action.orgDetails", "units"],
  orgSettlement: ["composer.action.orgSettlement", "units"],
  orgCreate: ["composer.action.orgCreate", "units"],
  orgRename: ["composer.action.orgRename", "units"],
  orgMove: ["composer.action.orgMove", "units"],
  orgDissolve: ["composer.action.orgDissolve", "units"],
  orgMerge: ["composer.action.orgMerge", "units"],
  orgReassign: ["composer.action.orgReassign", "people"],
  orgDelete: ["composer.action.orgDelete", "units"],
  orgChange: ["composer.action.orgChange", "units"],
  appointment: ["composer.action.appointment", "people"],
  ONBOARD: ["composer.action.registration", "people"],
  OFFBOARD: ["composer.action.exit", "people"],
  TERMINATE: ["composer.action.exit", "people"],
  EXIT_REVERSAL: ["composer.action.exit", "people"],
  REHIRE: ["composer.action.rehire", "people"],
  RESCIND: ["composer.action.appointment", "people"],
  TRANSFER: ["composer.action.TRANSFER", "people"],
  PROMOTE: ["composer.action.PROMOTE", "people"],
  APPOINT: ["composer.action.APPOINT", "people"],
  EMPLOYMENT_TYPE_CHANGE: ["composer.action.EMPLOYMENT_TYPE_CHANGE", "people"],
  CONTRACT_RENEWAL: ["composer.action.CONTRACT_RENEWAL", "people"],
  LEAVE_OF_ABSENCE: ["composer.action.LEAVE_OF_ABSENCE", "people"],
  RETURN_FROM_LEAVE: ["composer.action.RETURN_FROM_LEAVE", "people"],
  GROUP_TRANSFER: ["composer.action.GROUP_TRANSFER", "people"],
  exitReport: ["composer.action.exitReport", "people"],
  exit: ["composer.action.exit", "people"],
  exitHq: ["composer.action.exitHq", "people"],
  settlement: ["composer.action.settlement", "people"],
  identityMerge: ["composer.action.identityMerge", "people"],
  identityDifferent: ["composer.action.identityDifferent", "people"],
  rehire: ["composer.action.rehire", "people"],
  demotion: ["composer.action.demotion", "people"],
  profile: ["composer.action.profile", "people"],
  registration: ["composer.action.registration", "people"],
} as const;

/** Withdraw pending approval; cancel before effect; correct an applied fact; revoke an applied act. */
const ACTION_VERBS = {
  calculate: "composer.verb.calculate",
  approve: "composer.verb.approve",
  complete: "composer.verb.complete",
  apply: "composer.verb.apply",
  schedule: "composer.verb.schedule",
  request: "composer.verb.request",
  change: "composer.verb.change",
  correct: "composer.verb.correct",
  withdraw: "composer.verb.withdraw",
  cancel: "composer.verb.cancel",
  revoke: "composer.verb.revoke",
  reject: "composer.verb.reject",
  save: "composer.verb.save",
  remove: "composer.verb.remove",
} as const;

export type ActionDescription = { kind: keyof typeof ACTION_KINDS; mode: keyof typeof ACTION_VERBS; count?: number };

export const verbLabel = (mode: ActionDescription["mode"]): string => t(ACTION_VERBS[mode]);

export function commitLabel({ kind, mode, count }: ActionDescription): string {
  const [noun, unit] = ACTION_KINDS[kind];
  return t(count && count > 0 ? "composer.commit.count" : "composer.commit", {
    action: t(noun), verb: verbLabel(mode), count: count ?? 0, unit: t(`composer.unit.${unit}`),
  });
}
