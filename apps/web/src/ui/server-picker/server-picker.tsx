import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, ComboBox, FieldError, Input, Label, ListBox, ListBoxItem, Popover, Text, TextField } from "react-aria-components";
import { Plus, Search, Send } from "lucide-react";
import { t } from "@console/i18n";
import { homonymOf, suffixMatches, SUFFIX } from "./homonym";
import css from "./server-picker.module.css";

/** One server result. People carry `code` (employee number) and `status`, so a partial match or a namesake is never a guess. */
export type PickerOption = { id: string; name: string; display?: ReactNode; code?: string; status?: ReactNode; context?: ReactNode };

/**
 * The escape when the server finds nothing, never a dead end: with permission, add to the list right here
 * (recorded); without it, send a request to whoever can (it shows in the requester's waiting lane).
 */
export type PickerEscape =
  | { kind: "add"; label?: string; note?: ReactNode; onAdd: () => void }
  | { kind: "request"; label?: string; note: ReactNode; onRequest: () => void };

/**
 * Search picker over a large server list (people, units, positions). The caller owns the query: it searches on the
 * server (debounced by its setting) and passes the results. Nothing is picked from text alone: an option is chosen
 * only by selecting it, and choosing one of several people with the same name asks for the last digits of their
 * code first. No results show what is missing and the escape below the field, reachable by Tab.
 */
export function ServerPicker(p: {
  label: string;
  query: string;
  onQueryChange: (q: string) => void;
  options: PickerOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  /** The kind of result, shown over the list with its count (people, units). */
  group: string;
  loading?: boolean;
  /** What is missing and why (no such branch; HQ HR opens branches), shown beside the escape. */
  empty: ReactNode;
  escape?: PickerEscape;
  isRequired?: boolean;
  /** Total matching results when the server returns a page. */
  total?: number;
  readOnly?: boolean;
  disabledReason?: string;
  error?: ReactNode;
}) {
  const [pending, setPending] = useState<PickerOption>();
  const [suffix, setSuffix] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const body = input.current!.ownerDocument.body;
    const preserved = [...body.querySelectorAll<HTMLElement>("[inert]")];
    // A picker inside a Sheet: when the Sheet itself unmounts (Back, route change) its overlay's inert must not return.
    const host = input.current!.closest('[role="dialog"]');
    return () => {
      const restore = () => { for (const el of preserved) el.inert = true; };
      // A rapid reopen must snapshot the original restrictions before any microtask runs.
      restore();
      // On unmount, React Aria's child cleanup runs after ours and clears inert with aria-hidden.
      queueMicrotask(() => { if (!host || host.isConnected) restore(); });
    };
  }, [open]);
  const homonyms = homonymOf(p.options, pending);
  const pick = (key: string | null) => {
    if (p.readOnly || p.disabledReason) return;
    // React Aria re-reports the current key (e.g. on blur); a confirmed namesake must not be asked again.
    if (key !== null && key === p.value) return;
    const o = p.options.find((x) => x.id === key);
    setSuffix("");
    if (o?.code?.trim() && homonymOf(p.options, o).length > 1) {
      setPending(o);
      p.onChange(null);
      return;
    }
    setPending(undefined);
    p.onChange(o ? o.id : null);
  };
  const confirm = (text: string) => {
    if (p.readOnly || p.disabledReason) return;
    setSuffix(text);
    if (pending && suffixMatches(pending, text)) {
      p.onChange(pending.id);
      setPending(undefined);
      // The confirm field unmounts; keep focus on the picker instead of dropping it to the page.
      input.current?.focus();
    }
  };
  // Only while nothing is chosen: a selection writes its name back into the query, which may itself find nothing.
  const none = p.value === null && !pending && p.query.trim() !== "" && !p.loading && p.error == null && p.options.length === 0;
  const truncated = !p.loading && p.total != null && p.options.length > 0 && p.total > p.options.length;

  return (
    <div className={css.picker} data-readonly={p.readOnly || undefined}>
      <ComboBox
        className="field"
        items={p.options}
        inputValue={p.query}
        onInputChange={p.onQueryChange}
        onOpenChange={setOpen}
        selectedKey={pending ? pending.id : (p.value ?? null)}
        onSelectionChange={(k) => pick(k === null ? null : String(k))}
        menuTrigger={p.readOnly ? "manual" : "input"}
        allowsEmptyCollection
        isRequired={p.isRequired}
        isDisabled={Boolean(p.disabledReason)}
        isReadOnly={p.readOnly}
        isInvalid={p.error != null || undefined}
      >
        <Label className="field__label">{p.label}</Label>
        <div className={css.input}>
          <Search aria-hidden="true" className={css.icon} />
          <Input ref={input} className="field__input" />
        </div>
        {p.disabledReason && <Text slot="description" className={css.sub}>{p.disabledReason}</Text>}
        <FieldError className={css.error}>{p.error}</FieldError>
        <Popover className={`popover ${css.pop}`}>
          <div className={css.group}>
            <span aria-hidden="true">{p.group}</span>
            <span role="status">{p.loading ? t("uiServerPicker.loading") : t("uiServerPicker.count", { count: p.total ?? p.options.length })}</span>
          </div>
          <ListBox className="listbox" shouldFocusOnHover={false} renderEmptyState={() => <div className={css.empty}>{p.loading ? t("uiServerPicker.loading") : t("uiServerPicker.none")}</div>}>
            {(o: PickerOption) => (
              <ListBoxItem id={o.id} textValue={o.name} className={`listbox__item ${css.option}`}>
                <span className={css.name}>{o.display ?? o.name}</span>
                {o.code && !o.display && <span className={css.code}>{o.code}</span>}
                {(o.context || o.status) && <span className={css.sub}>{o.context && <span>{o.context}</span>}{o.status && <span>{o.status}</span>}</span>}
              </ListBoxItem>
            )}
          </ListBox>
          <div className={css.foot} aria-hidden={truncated ? undefined : true}>{truncated ? t("uiServerPicker.narrow", { count: p.options.length }) : t("uiServerPicker.keys")}</div>
        </Popover>
      </ComboBox>
      {pending && homonyms.length > 1 && (
        <TextField className={`field ${css.homonym}`} value={suffix} onChange={confirm} isRequired isReadOnly={p.readOnly} isDisabled={Boolean(p.disabledReason)}>
          <Label className="field__label">{t("uiServerPicker.homonym", { count: homonyms.length, digits: SUFFIX })}</Label>
          <Input className={`field__input ${css.suffix}`} inputMode="numeric" maxLength={SUFFIX} autoComplete="off" />
          <Text slot="description" className={css.sub}>{t("uiServerPicker.homonym.echo", { name: pending.name, code: pending.code ?? "" })}</Text>
        </TextField>
      )}
      {none && (
        <div className={css.escape}>
          <span className={css.missing} role="status">{p.empty}</span>
          {p.escape && (
            <Button className="btn" isDisabled={Boolean(p.readOnly || p.disabledReason)} onPress={p.escape.kind === "add" ? p.escape.onAdd : p.escape.onRequest}>
              {p.escape.kind === "add" ? <Plus aria-hidden="true" /> : <Send aria-hidden="true" />}
              {p.escape.label ?? t(`uiServerPicker.escape.${p.escape.kind}`, { query: p.query.trim() })}
            </Button>
          )}
          {p.escape?.note && <span className={css.sub}>{p.escape.note}</span>}
        </div>
      )}
    </div>
  );
}
