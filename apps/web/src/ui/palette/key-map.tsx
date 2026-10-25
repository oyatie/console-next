import { useState, type ReactNode } from "react";
import { ModalOverlay, Dialog, Heading, Input, Modal, SearchField } from "react-aria-components";
import { Info, Search } from "lucide-react";
import { Kbd } from "../record/record-section";
import s from "./palette.module.css";

export type KeyGroup = { id: string; title: string; keys: { keys: string[]; what: string }[] };

/**
 * The key map overlay (?): every group of keys that works on this screen, from one registry; typing in its box narrows
 * the rows to a key or a task (R27); Esc closes.
 */
export function KeyMap({ open, onClose, title, note, groups, filter }: { open: boolean; onClose: () => void; title: string; note?: ReactNode; groups: KeyGroup[]; filter?: { label: string; hint?: ReactNode } }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? groups.map((g) => ({ ...g, keys: g.keys.filter((k) => k.what.toLowerCase().includes(needle) || k.keys.some((x) => x.toLowerCase() === needle)) })).filter((g) => g.keys.length)
    : groups;
  return (
    <ModalOverlay className={s.overlay} isOpen={open} onOpenChange={(o) => !o && onClose()} isDismissable>
      <Modal className={s.pal} data-wide>
        <Dialog className={s.dialog}>
          <div className={s.in}>
            <Info size={18} aria-hidden /><Heading slot="title" className={s.keyTitle}>{title}</Heading>
            {filter && (
              <SearchField className={s.keyFind} aria-label={filter.label} value={q} onChange={setQ}>
                <Search size={14} aria-hidden /><Input className={s.input} placeholder={filter.label} />
              </SearchField>
            )}
            {filter?.hint && <span className={s.keyHint}>{filter.hint}</span>}
            <span className={s.grow} />
            <Kbd k="Esc" />
          </div>
          <div className={s.keys}>
            {shown.map((g) => (
              <section key={g.id} aria-label={g.title}>
                <h3 className={s.keyGroup}>{g.title}</h3>
                {g.keys.map((k) => (
                  <div key={k.what} className={s.keyRow}><span>{k.keys.map((x) => <Kbd key={x} k={x} />)}</span><span>{k.what}</span></div>
                ))}
              </section>
            ))}
          </div>
          {note && <div className={s.foot}>{note}</div>}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
