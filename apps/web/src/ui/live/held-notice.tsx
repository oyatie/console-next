import { useEffect, useRef, useSyncExternalStore } from "react";
import { t } from "@console/i18n";
import { liveHeld, showHeld } from "../../lib/live/live";
import { ROW_SELECTOR } from "../long-table/row-keys";
import { Button } from "../button/button";
import s from "./live.module.css";

let mountedLists = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const lists = {
  get: () => mountedLists,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};

/** Held changes overlay the list; the shell remains the fallback for other notice holds. */
export function HeldNotice({ placement = "float" }: { placement?: "float" | "list" }) {
  const count = useSyncExternalStore(liveHeld.subscribe, liveHeld.get, liveHeld.get);
  const mounted = useSyncExternalStore(lists.subscribe, lists.get, lists.get);
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (placement !== "list") return;
    mountedLists++;
    emit();
    return () => { mountedLists--; emit(); };
  }, [placement]);
  const apply = async () => {
    const region = notice.current?.parentElement;
    await showHeld();
    if (placement !== "list") return;
    // Query observers publish on the next task; focus after their replacement rows commit.
    setTimeout(() => requestAnimationFrame(() => {
      if (!region?.isConnected) return;
      const target = region.querySelector<HTMLElement>(ROW_SELECTOR) ?? region;
      if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }), 0);
  };
  if (placement === "float" && (mounted || !count)) return null;
  return (
    <div ref={notice} className={placement === "list" ? s.list : `notice ${s.held}`} role="status">
      {!!count && <Button variant="ghost" className={placement === "list" ? s.listChip : undefined} onClick={() => void apply()}>{t("live.list.new_rows", { count })}</Button>}
    </div>
  );
}
