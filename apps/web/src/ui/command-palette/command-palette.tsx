import { useDeferredValue, useEffect, useRef, type ReactNode, type RefObject } from "react";
import { ModalOverlay, Autocomplete, Dialog, Header, Input, Keyboard, Menu, MenuItem, MenuSection, Modal, SearchField, Text } from "react-aria-components";
import { Search } from "lucide-react";
import { t } from "@console/i18n";
import { isImeKey, leaveImeKey } from "../../lib/pure/ime";
import s from "./command-palette.module.css";

export type PaletteItem = { id: string; icon?: ReactNode; label: string; detail?: string; meta?: string; onAction: () => void };
export type PaletteSection = { id: string; title: string; items: readonly PaletteItem[] };

/**
 * Drawn inside the first result while there is a search, so it runs once the list holds that result, and drawn anew
 * whenever the text or the first result changes (people the server finds late, a paste, a deletion). Each time, the
 * box is sent a Home key, which React Aria answers by giving the first result the list's focus: Enter opens it, the
 * arrows move on from it. The key is made here, not pressed, so it does not touch what an input method is composing.
 */
function First({ box }: { box: RefObject<HTMLInputElement | null> }) {
  useEffect(() => void box.current?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", code: "Home", bubbles: true, cancelable: true })), [box]);
  return null;
}

/**
 * The jump palette (⌘K, spec S1-jump): one search field over sections of places, people and tasks. The caller
 * filters (a server search for people); arrows move through the results with the field keeping focus, Enter acts,
 * Esc closes. No single-key badges here (SC 2.1.4): the keys live only on the chart itself.
 */
export function CommandPalette({ open, onClose, label, placeholder, query, onQuery, sections, footer, empty }: {
  open: boolean;
  onClose: () => void;
  label: string;
  placeholder: string;
  query: string;
  onQuery: (q: string) => void;
  sections: readonly PaletteSection[];
  footer?: ReactNode;
  empty?: ReactNode;
}) {
  const shown = sections.filter((x) => x.items.length > 0);
  const box = useRef<HTMLInputElement>(null);
  // A caller's results may trail the text by a render (a deferred search), so the first result is marked only once that
  // render has caught up with the box. Text that returns to what it was before then is still marked afresh.
  const searched = useDeferredValue(query);
  const first = searched.trim() && searched === query ? shown[0]?.items[0]?.id : undefined;
  return (
    <ModalOverlay className={s.overlay} isOpen={open} onOpenChange={(o) => !o && onClose()} isDismissable>
      <Modal className={s.modal}>
        <Dialog className={s.dialog} aria-label={label}>
          <Autocomplete inputValue={query} onInputChange={onQuery}>
            {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- A palette opened by its chord or its button must take typing at once. */}
            <SearchField className={s.field} aria-label={label} autoFocus>
              <Search size={18} aria-hidden />
              {/* An Enter the input method owns ends a syllable; it is not a command, and stops here as its Escape and Tab do. */}
              <Input ref={box} className={s.input} placeholder={placeholder} onKeyDownCapture={(e) => { leaveImeKey(e); if (e.key === "Enter" && isImeKey(e)) e.stopPropagation(); }} />
              <Keyboard className={s.kbd}>{t("uiCommandPalette.esc")}</Keyboard>
            </SearchField>
            <Menu
              className={s.menu}
              aria-label={label}
              renderEmptyState={() => <div className={s.empty}>{empty}</div>}
              onAction={(key) => {
                const item = shown.flatMap((x) => x.items).find((i) => i.id === key);
                if (!item) return;
                onClose();
                item.onAction();
              }}
            >
              {shown.map((sec) => (
                <MenuSection key={sec.id} id={sec.id} className={s.section}>
                  <Header className={s.header}>{sec.title}</Header>
                  {sec.items.map((i) => (
                    <MenuItem key={i.id} id={i.id} textValue={`${i.label} ${i.detail ?? ""}`} className={s.item}>
                      {i.id === first && <First key={searched} box={box} />}
                      {i.icon}
                      <Text slot="label" className={s.label}>{i.label}</Text>
                      {i.detail && <Text slot="description" className={s.detail}>{i.detail}</Text>}
                      {i.meta && <span className={s.meta}>{i.meta}</span>}
                    </MenuItem>
                  ))}
                </MenuSection>
              ))}
            </Menu>
          </Autocomplete>
          {footer != null && <div className={s.foot}>{footer}</div>}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
