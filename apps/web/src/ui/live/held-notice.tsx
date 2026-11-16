import { useEffect, useRef, useSyncExternalStore } from "react";
import { t } from "@console/i18n";
import { liveHeld, showHeld } from "../../lib/live/live";
import { ROW_SELECTOR } from "../long-table/row-keys";
import { Button } from "../button/button";
import { StatusDock } from "../status-dock/status-dock";
import s from "./live.module.css";

let visibleLists = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const lists = {
  get: () => visibleLists,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};

/** Held changes overlay the list; the shell remains the fallback for other notice holds. */
export function HeldNotice({ placement = "float" }: { placement?: "float" | "list" }) {
  const count = useSyncExternalStore(liveHeld.subscribe, liveHeld.get, liveHeld.get);
  const visible = useSyncExternalStore(lists.subscribe, lists.get, lists.get);
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (placement !== "list" || !notice.current) return;
    let visible = false;
    const update = (next: boolean) => {
      if (next === visible) return;
      visible = next;
      visibleLists += next ? 1 : -1;
      emit();
    };
    // Responsive columns keep the list mounted while display:none hides it.
    const observer = new ResizeObserver(([entry]) => update(entry!.contentRect.width > 0));
    observer.observe(notice.current);
    return () => { observer.disconnect(); update(false); };
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
  if (placement === "float" && (visible || !count)) return null;
  const content = (
    <div ref={notice} className={placement === "list" ? s.list : `notice ${s.held}`} role="status">
      {!!count && <Button variant="ghost" className={placement === "list" ? s.listChip : undefined} onClick={() => void apply()}>{t("live.list.new_rows", { count })}</Button>}
    </div>
  );
  return placement === "list" ? content : <StatusDock>{content}</StatusDock>;
}
