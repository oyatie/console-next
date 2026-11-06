import { useId, type ReactNode } from "react";
import { Button, Dialog, DialogTrigger, Heading, Popover } from "react-aria-components";
import s from "./popover.module.css";

/**
 * A small trigger ("show", "choose purpose") that opens a non-modal panel beside it: a heading, then `children`
 * given `close`. Focus moves in and returns to the trigger; Esc closes.
 */
export function PopoverButton({ trigger, label, title, children, link, chip, wide, isOpen, onOpenChange }: { trigger: ReactNode; label: string; title: ReactNode; children: (close: () => void) => ReactNode; link?: boolean; chip?: boolean; wide?: boolean; isOpen?: boolean; onOpenChange?: (open: boolean) => void }) {
  const titleId = useId();
  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
      <Button className={link ? s.link : chip ? "btn btn--chip" : "btn btn--ghost"} aria-label={label}>{trigger}</Button>
      <Popover className={wide ? `${s.pop} ${s.wide}` : s.pop} placement="bottom start">
        <Dialog aria-labelledby={titleId} className={s.dialog}>
          {({ close }) => (
            <>
              <Heading id={titleId} slot="title" className={s.head}>{title}</Heading>
              <div className={s.body}>{children(close)}</div>
            </>
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
