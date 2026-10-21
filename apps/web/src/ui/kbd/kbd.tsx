import s from "./kbd.module.css";

/** A key or chord shown beside the command it runs (⌘↵, J, Ctrl+D). Decorative: the command's name says what it does. */
export const Kbd = ({ keys }: { keys: string }) => <kbd className={s.kbd} aria-hidden="true">{keys}</kbd>;
