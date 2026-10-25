import type { ReactNode } from "react";
import { ModalOverlay, Dialog, Input, ListBox, ListBoxItem, ListBoxSection, Header, Modal, TextField, Label } from "react-aria-components";
import { Search } from "lucide-react";
import { Kbd } from "../record/record-section";
import s from "./palette.module.css";

export type PaletteItem = { id: string; text: string; title: ReactNode; meta?: ReactNode; end?: ReactNode; icon?: ReactNode; disabled?: boolean };
export type PaletteSection = { id: string; title: ReactNode; items: PaletteItem[] };

/**
 * The command palette (⌘K): a search field over sections of results, keyboard first (↑↓ moves, Enter acts, Esc
 * closes), modal at the top of the screen so the page stays recognisable behind it. `notice` sits above the sections
 * (why nothing matched, what scope was searched); `foot` names the rules.
 */
export function Palette({ open, onClose, label, query, onQuery, placeholder, sections, onAction, notice, foot }: {
  open: boolean;
  onClose: () => void;
  label: string;
  query: string;
  onQuery: (q: string) => void;
  placeholder: string;
  sections: PaletteSection[];
  onAction: (id: string) => void;
  notice?: ReactNode;
  foot?: ReactNode;
}) {
  const disabled = sections.flatMap((x) => x.items).filter((i) => i.disabled).map((i) => i.id);
  // Enter in the box acts on the first result: it is marked as the one Enter takes.
  const firstId = sections.flatMap((x) => x.items).find((i) => !i.disabled)?.id;
  return (
    <ModalOverlay className={s.overlay} isOpen={open} onOpenChange={(o) => !o && onClose()} isDismissable>
      {/* Full height from the first frame: results that answer later fill it, never move its foot. */}
      <Modal className={s.pal} data-full>
        <Dialog className={s.dialog} aria-label={label}>
          <TextField className={s.in} value={query} onChange={onQuery} aria-label={label}>
            <Label className="sr-only">{label}</Label>
            <Search size={18} aria-hidden />
            <Input
              className={s.input}
              type="search"
              role="searchbox"
              placeholder={placeholder}
              // Enter acts on the first result (an exact employee number goes straight to its person); ↓ walks into the list.
              onKeyDown={(e) => {
                const first = sections.flatMap((x) => x.items).find((i) => !i.disabled);
                if (e.key === "Enter" && first) {
                  e.preventDefault();
                  onAction(first.id);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  e.currentTarget.closest("[role=dialog]")?.querySelector<HTMLElement>("[role=option]:not([aria-disabled=true])")?.focus();
                }
              }}
            />
            <Kbd k="Esc" />
          </TextField>
          {notice && <div className={s.notice} role="status">{notice}</div>}
          <ListBox className={s.list} aria-label={label} disabledKeys={disabled} onAction={(k) => onAction(String(k))} renderEmptyState={() => null}>
            {sections.map((sec) => (
              <ListBoxSection key={sec.id} id={sec.id} className={s.section}>
                <Header className={s.sec}>{sec.title}</Header>
                {sec.items.map((i) => (
                  <ListBoxItem key={i.id} id={i.id} textValue={i.text} className={i.id === firstId && query ? `${s.row} ${s.first}` : s.row}>
                    {i.icon && <span className={s.icon} aria-hidden>{i.icon}</span>}
                    <span className={s.main}><span className={s.title}>{i.title}</span>{i.meta && <span className={s.meta}>{i.meta}</span>}</span>
                    {i.end && <span className={s.end}>{i.end}</span>}
                  </ListBoxItem>
                ))}
              </ListBoxSection>
            ))}
          </ListBox>
          {foot && <div className={s.foot}>{foot}</div>}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
