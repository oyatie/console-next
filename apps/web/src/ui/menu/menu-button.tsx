import type { ReactNode } from "react";
import { Button, Menu, MenuItem, MenuTrigger, Popover } from "react-aria-components";
import { ChevronDown } from "lucide-react";
import s from "./menu.module.css";

/** One menu entry: `why` makes it unavailable and says why in place (never a silent omission); `hint` is its key. */
export type MenuEntry = { id: string; label: ReactNode; text: string; hint?: ReactNode; why?: ReactNode };

/**
 * A button that opens a menu of commands (personnel action ▾, ⋯). An unavailable entry stays listed, not pressable, with its
 * reason under it. `icon` replaces the label for an icon-only trigger, which then needs `label`.
 */
export function MenuButton({ label, icon, primary, items, onAction, caret = true }: { label: string; icon?: ReactNode; primary?: boolean; items: MenuEntry[]; onAction: (id: string) => void; caret?: boolean }) {
  const disabled = items.filter((i) => i.why).map((i) => i.id);
  return (
    <MenuTrigger>
      <Button className={icon && !caret && !primary ? `btn ${s.icon}` : `btn${primary ? " btn--primary" : ""}`} aria-label={icon && !caret ? label : undefined}>
        {icon}
        {(!icon || caret) && <span>{label}</span>}
        {caret && <ChevronDown size={14} aria-hidden />}
      </Button>
      <Popover className={s.pop} placement="bottom end">
        <Menu className={s.menu} aria-label={label} disabledKeys={disabled} onAction={(k) => onAction(String(k))}>
          {items.map((i) => (
            <MenuItem key={i.id} id={i.id} className={s.item} textValue={i.text}>
              <span className={s.label}>{i.label}</span>
              {i.hint && <span className={s.hint}>{i.hint}</span>}
              {i.why && <span className={s.why}>{i.why}</span>}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
