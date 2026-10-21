import type { ReactNode } from "react";
import { ArrowRight, Building2, Calendar, CornerDownRight, FileText, Flag, Layers, Lock, MapPin, RefreshCw, User } from "lucide-react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { useCan } from "../../../reference/authz/ui/use-can";
import { ActionGrid, type ActionItem } from "../../../ui/action-grid/action-grid";
import { LIFECYCLE_EVENT, label } from "../../../lib/labels";
import type { Verb, VerbState } from "../domain/lifecycle";
import { whyText } from "../present";

type Detail = components["schemas"]["EmployeeDetail"];

/**
 * The kinds of personnel act for one person (spec E5-menu): grouped, each with its letter key; what the server offers
 * opens its sheet, the rest stay listed with why (not on leave, not served yet, restricted). Exit opens the exit
 * report; several people are done from the roster's selection instead.
 */
export function LifecycleMenu({ d, verbs, setup, onOpen, onClose }: { d: Detail; verbs: readonly VerbState[]; setup: boolean; onOpen: (act: string) => void; onClose: () => void }) {
  const can = useCan();
  const e = d.employee;
  const state = (v: Verb) => verbs.find((x) => x.verb === v);
  const why = (v: Verb) => {
    const s = state(v);
    return !s ? t("lifecycle.menu.closed") : s.enabled ? undefined : whyText(s.why, [label(LIFECYCLE_EVENT, v)]);
  };
  type K = "transfer" | "relocate" | "group" | "second" | "promote" | "appoint" | "job" | "convert" | "renew" | "pattern" | "leave" | "return" | "standby" | "suspend" | "exit" | "void";
  const item = (id: string, icon: ReactNode, key: Exclude<K, "second" | "pattern" | "standby" | "suspend" | "void">, keys: string | undefined, disabled?: string): ActionItem => ({ id, icon, title: t(`lifecycle.menu.${key}`), desc: t(`lifecycle.menu.${key}Desc`), keys, disabled });
  const closed = (id: string, icon: ReactNode, key: K, reason: string): ActionItem => ({ id, icon, title: t(`lifecycle.menu.${key}`), desc: reason, disabled: reason });
  const leaving = e.status === "ON_LEAVE";
  const groups = [
    {
      title: t("lifecycle.menu.group.place"),
      items: [
        item("TRANSFER", <CornerDownRight size={14} />, "transfer", "M", why("TRANSFER")),
        item("TRANSFER:relocate", <MapPin size={14} />, "relocate", "T", why("TRANSFER")),
        item("GROUP_TRANSFER", <Building2 size={14} />, "group", "G", why("GROUP_TRANSFER")),
        closed("second", <Building2 size={14} />, "second", t("lifecycle.menu.closed")),
      ],
    },
    {
      title: t("lifecycle.menu.group.title"),
      items: [
        item("PROMOTE", <ArrowRight size={14} />, "promote", "P", why("PROMOTE")),
        item("APPOINT", <User size={14} />, "appoint", "R", why("APPOINT")),
        item("APPOINT:job", <Layers size={14} />, "job", "J", why("APPOINT")),
      ],
    },
    {
      title: t("lifecycle.menu.group.employ"),
      items: [
        item("EMPLOYMENT_TYPE_CHANGE", <RefreshCw size={14} />, "convert", "C", why("EMPLOYMENT_TYPE_CHANGE")),
        item("CONTRACT_RENEWAL", <FileText size={14} />, "renew", "N", why("CONTRACT_RENEWAL")),
        closed("pattern", <Calendar size={14} />, "pattern", t("lifecycle.menu.patternWhy")),
      ],
    },
    {
      title: t("lifecycle.menu.group.leave"),
      items: [
        item("LEAVE_OF_ABSENCE", <Calendar size={14} />, "leave", "L", leaving ? t("lifecycle.menu.onLeave") : why("LEAVE_OF_ABSENCE")),
        item("RETURN_FROM_LEAVE", <Calendar size={14} />, "return", "B", leaving ? why("RETURN_FROM_LEAVE") : t("lifecycle.menu.notOnLeave")),
        closed("standby", <Lock size={14} />, "standby", t("lifecycle.menu.restricted")),
        closed("suspend", <Lock size={14} />, "suspend", t("lifecycle.menu.restricted")),
        item("exit.report", <Flag size={14} />, "exit", "⌘X", can("exit_case_report") && e.status !== "EXITED" ? undefined : t("lifecycle.menu.noExit")),
      ],
    },
  ];
  return (
    <ActionGrid
      label={t("lifecycle.menu.label")}
      head={<><CornerDownRight size={14} aria-hidden />{t(setup ? "lifecycle.menu.headSetup" : "lifecycle.menu.headOp", { name: e.name })}</>}
      groups={groups}
      tail={closed("void", <Lock size={14} />, "void", t("lifecycle.menu.voidWhy"))}
      foot={t("lifecycle.menu.foot")}
      onPick={(id) => onOpen(id.split(":")[0]!)}
      onClose={onClose}
    />
  );
}
