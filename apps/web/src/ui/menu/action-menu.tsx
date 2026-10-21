import type { ReactNode } from "react";
import { Button, Keyboard, Menu, MenuItem, MenuTrigger, Popover, Text } from "react-aria-components";
import s from "./action-menu.module.css";

export type MenuAction = { id: string; label: string; shortcut?: string; danger?: boolean; onAction: () => void };

/**
 * A ⋯ menu of a record's verbs with their keys (spec R24): React Aria menu, arrow keys inside, Esc back to the
 * trigger. `open` makes it controllable, so a right-click or Shift+F10 on the record opens the same menu.
 */
export function ActionMenu({ label, trigger, actions, open, onOpenChange }: {
  label: string;
  trigger: ReactNode;
  actions: readonly MenuAction[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <MenuTrigger isOpen={open} onOpenChange={onOpenChange}>
      <Button className="btn btn--ghost" aria-label={label}>{trigger}</Button>
      <Popover className={`popover ${s.pop}`} placement="bottom end">
        {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- An explicitly opened menu must focus its first action, including Shift+F10. */}
        <Menu className={s.menu} aria-label={label} autoFocus="first" onAction={(key) => actions.find((a) => a.id === key)?.onAction()}>
          {actions.map((a) => (
            <MenuItem key={a.id} id={a.id} textValue={a.label} className={s.item} data-danger={a.danger || undefined}>
              <Text slot="label">{a.label}</Text>
              {a.shortcut && <Keyboard className={s.kbd}>{a.shortcut}</Keyboard>}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
