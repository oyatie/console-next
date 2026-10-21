import type { ReactNode } from "react";
import { Button, Dialog, DialogTrigger, Heading, Popover } from "react-aria-components";
import s from "./popover.module.css";

/**
 * A small trigger ("show", "choose purpose") that opens a non-modal panel beside it: a heading, then `children`
 * given `close`. Focus moves in and returns to the trigger; Esc closes.
 */
export function PopoverButton({ trigger, label, title, children, link, wide }: { trigger: ReactNode; label: string; title: ReactNode; children: (close: () => void) => ReactNode; link?: boolean; wide?: boolean }) {
  return (
    <DialogTrigger>
      <Button className={link ? s.link : "btn btn--ghost"} aria-label={label}>{trigger}</Button>
      <Popover className={wide ? `${s.pop} ${s.wide}` : s.pop} placement="bottom start">
        <Dialog className={s.dialog}>
          {({ close }) => (
            <>
              <Heading slot="title" className={s.head}>{title}</Heading>
              <div className={s.body}>{children(close)}</div>
            </>
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
