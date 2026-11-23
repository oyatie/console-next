import { useDeferredValue, useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ModalOverlay, Autocomplete, Dialog, Header, Input, Keyboard, Menu, MenuItem, MenuSection, Modal, SearchField, Text, type Key } from "react-aria-components";
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
 * A row the person has moved to with the keys is theirs: until the text changes, late results do not take the
 * highlight back.
 */
function First({ box, moved }: { box: RefObject<HTMLInputElement | null>; moved: RefObject<boolean> }) {
  useEffect(() => void (moved.current || box.current?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", code: "Home", bubbles: true, cancelable: true }))), [box, moved]);
  return null;
}

/** The keys that move the highlight through the results. */
const MOVES = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);

/**
 * The jump palette (⌘K, spec S1-jump): one search field over sections of places, people and tasks. The caller
 * filters (a server search for people); arrows move through the results with the field keeping focus, Enter acts,
 * Esc closes. No single-key badges here (SC 2.1.4): the keys live only on the chart itself.
 */
export function CommandPalette({ open, onClose, label, placeholder, query, onQuery, sections, pending, footer, empty }: {
  open: boolean;
  onClose: () => void;
  label: string;
  placeholder: string;
  query: string;
  onQuery: (q: string) => void;
  sections: readonly PaletteSection[];
  /** A search for the text is still out and its answer may become the first result. */
  pending?: boolean;
  footer?: ReactNode;
  empty?: ReactNode;
}) {
  const shown = sections.filter((x) => x.items.length > 0);
  const box = useRef<HTMLInputElement>(null);
  // Set by a pressed key that moves the highlight, until the text changes. The Home made for the first result is not pressed.
  const moved = useRef(false);
  // A caller's results may trail the text by a render (a deferred search), so the first result is marked only once that
  // render has caught up with the box. Text that returns to what it was before then is still marked afresh.
  const searched = useDeferredValue(query);
  // The list is the one for the text in the box, and no answer still out can put another result first.
  const settled = !pending && searched === query;
  const first = settled && searched.trim() ? shown[0]?.items[0]?.id : undefined;
  const act = (id: Key) => {
    const item = shown.flatMap((x) => x.items).find((i) => i.id === id);
    if (!item) return;
    onClose();
    item.onAction();
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    leaveImeKey(e);
    if (e.isTrusted && MOVES.has(e.key)) moved.current = true;
    // Escape empties the box. React Aria is told it is a deletion, so it drops the highlight as it does for Backspace.
    // Untold, it takes the emptying for the letter typed last, highlights the first standing task, and Enter opens it.
    if (e.key === "Escape" && !isImeKey(e)) e.currentTarget.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContent" }));
    if (e.key !== "Enter") return;
    // An Enter the input method owns ends a syllable; it is not a command, and stops here as its Escape and Tab do.
    // Nor does Enter open a first result that may still change: it waits, unless the person chose a row with the keys.
    if (isImeKey(e) || (!settled && !moved.current)) return e.stopPropagation();
    // A caret move or a click in the box drops the highlight, and React Aria's Enter then opens nothing. With no row
    // highlighted, Enter opens the first result.
    if (!first || e.currentTarget.closest("[role=dialog]")?.querySelector("[role=menuitem][data-focused]")) return;
    e.preventDefault();
    e.stopPropagation();
    act(first);
  };
  return (
    <ModalOverlay className={s.overlay} isOpen={open} onOpenChange={(o) => !o && onClose()} isDismissable>
      <Modal className={s.modal}>
        <Dialog className={s.dialog} aria-label={label}>
          <Autocomplete inputValue={query} onInputChange={(q) => { moved.current = false; onQuery(q); }}>
            {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- A palette opened by its chord or its button must take typing at once. */}
            <SearchField className={s.field} aria-label={label} autoFocus>
              <Search size={18} aria-hidden />
              <Input ref={box} className={s.input} placeholder={placeholder} onKeyDownCapture={keys} />
              <Keyboard className={s.kbd}>{t("uiCommandPalette.esc")}</Keyboard>
            </SearchField>
            {/* Always mounted, so a screen reader hears the search start; it says why an Enter pressed now opens nothing. */}
            <p role="status" className={s.status}>{pending && query.trim() ? t("uiCommandPalette.searching") : ""}</p>
            <Menu
              className={s.menu}
              aria-label={label}
              renderEmptyState={() => <div className={s.empty}>{empty}</div>}
              onAction={act}
            >
              {shown.map((sec) => (
                <MenuSection key={sec.id} id={sec.id} className={s.section}>
                  <Header className={s.header}>{sec.title}</Header>
                  {sec.items.map((i) => (
                    <MenuItem key={i.id} id={i.id} textValue={`${i.label} ${i.detail ?? ""}`} className={s.item}>
                      {i.id === first && <First key={searched} box={box} moved={moved} />}
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
