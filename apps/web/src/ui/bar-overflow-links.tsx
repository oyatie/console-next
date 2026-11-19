// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { fmtNumber } from "@console/i18n/format";
import { isImeKey } from "../lib/pure/ime";
import s from "./bar-overflow-links.module.css";

type OverflowLinkEntry = {
  id: string;
  label: string;
  href: string;
  count?: number;
  current?: boolean;
};

/**
 * Accessible disclosure menu of overflow navigation links (`aria-expanded`, `Escape` and outside-pointer dismissal,
 * `ArrowDown`/`ArrowUp`/`Home`/`End` focus movement across links) with zero heavy overlay dependencies.
 */
export function BarOverflowLinks({
  label,
  trigger,
  triggerClassName = "btn btn--ghost",
  triggerActive = false,
  placement = "bottom",
  entries,
  onSelect,
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  triggerActive?: boolean;
  placement?: "bottom" | "top";
  entries: readonly OverflowLinkEntry[];
  onSelect?: (entry: OverflowLinkEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("a")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && event.target instanceof Node && !wrapRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || isImeKey(event)) return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const onLinkKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (isImeKey(event)) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const list = event.currentTarget.closest("ul");
    if (!list) return;
    const links = Array.from(list.querySelectorAll<HTMLElement>("a"));
    if (links.length === 0) return;
    event.preventDefault();
    const currentIdx = links.indexOf(event.currentTarget);
    const nextIdx =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? links.length - 1
          : event.key === "ArrowDown"
            ? (currentIdx + 1) % links.length
            : (currentIdx - 1 + links.length) % links.length;
    links[nextIdx]?.focus();
  };

  return (
    <div ref={wrapRef} className={s.wrap}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-expanded={open}
        data-active={triggerActive || undefined}
        onClick={() => setOpen(prev => !prev)}
      >
        {trigger}
      </button>
      {open ? (
        <ul ref={panelRef} className={s.panel} data-placement={placement}>
          {entries.map(entry => (
            <li key={entry.id} className={s.item}>
              <a
                href={entry.href}
                className={s.link}
                aria-current={entry.current ? "page" : undefined}
                onKeyDown={onLinkKeyDown}
                onClick={event => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  if (onSelect) {
                    event.preventDefault();
                    onSelect(entry);
                  }
                  setOpen(false);
                }}
              >
                <bdi>{entry.label}</bdi>
                {entry.count !== undefined && entry.count > 0 ? <data value={String(entry.count)}>{fmtNumber(entry.count)}</data> : null}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
