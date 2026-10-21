import type { ReactNode } from "react";
import { Autocomplete, Dialog, Header, Input, Keyboard, Menu, MenuItem, MenuSection, Modal, ModalOverlay, SearchField, Text } from "react-aria-components";
import { Search } from "lucide-react";
import { t } from "@console/i18n";
import s from "./command-palette.module.css";

export type PaletteItem = { id: string; icon?: ReactNode; label: string; detail?: string; meta?: string; onAction: () => void };
export type PaletteSection = { id: string; title: string; items: readonly PaletteItem[] };

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
  return (
    <ModalOverlay className={s.overlay} isOpen={open} onOpenChange={(o) => !o && onClose()} isDismissable>
      <Modal className={s.modal}>
        <Dialog className={s.dialog} aria-label={label}>
          <Autocomplete inputValue={query} onInputChange={onQuery}>
            <SearchField className={s.field} aria-label={label}>
              <Search size={18} aria-hidden />
              <Input className={s.input} placeholder={placeholder} />
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
