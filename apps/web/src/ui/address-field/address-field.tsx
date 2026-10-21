import { useState, type ReactNode } from "react";
import { ComboBox, Input, Label, ListBox, ListBoxItem, Popover } from "react-aria-components";
import { MapPin, Search } from "lucide-react";
import { t } from "@console/i18n";
import { Field, Marker, TextInput } from "../field/field";
import fieldCss from "../field/field.module.css";
import css from "../server-picker/server-picker.module.css";
import s from "./address-field.module.css";

/** One road-name address search result (juso.go.kr via the server). `key` is the building management number. */
export type AddressHit = { key: string; road: string; jibun: string; zip: string; building?: string };
/** A chosen address: `verified` when it came from the search, false when typed by hand while search was down. */
export type AddressValue = { key?: string; road: string; jibun?: string; zip: string; detail: string; verified: boolean };
/** Why the search cannot answer: too broad a keyword, or the service is unavailable (then the field turns manual). */
export type AddressProblem = "narrow" | "unavailable";

/**
 * A Korean address (design §2.3): search the official road-name address service, pick a result, then add
 * the unit (building, floor and room). The search runs on the server; the caller passes its results. If the service is
 * unavailable the field turns into manual entry marked "needs verification", so setup never stops on it.
 * `printed` is the address as printed on a document, shown for comparison. `children` show under a hand-typed
 * address only (e.g. a district pick that gives it its codes).
 */
export function AddressField({ label, required, value, onChange, query, onQueryChange, hits, loading, problem, printed, error, children }: {
  label: string;
  required: boolean;
  value: AddressValue | null;
  onChange: (v: AddressValue | null) => void;
  query: string;
  onQueryChange: (q: string) => void;
  hits: readonly AddressHit[];
  loading?: boolean;
  problem?: AddressProblem | null;
  printed?: ReactNode;
  error?: ReactNode;
  children?: ReactNode;
}) {
  const [manual, setManual] = useState(false);
  const typing = manual || problem === "unavailable";
  const compare = printed != null && <span className={s.printed}>{t("uiAddressField.printed")} {printed}</span>;
  if (value)
    return (
      <div className={s.wrap} role="group" aria-label={label}>
        <span className={fieldCss.label}>{label}<Marker required={required} /></span>
        <div className={s.chosen}>
          <MapPin size={16} aria-hidden className={s.pin} />
          <span className={s.lines}>
            <span className={s.road}>{value.road}</span>
            {value.jibun && <span className={s.sub}>{t("uiAddressField.jibun", { jibun: value.jibun })}</span>}
            <span className={s.sub}>{t("uiAddressField.zip", { zip: value.zip })}</span>
          </span>
          {!value.verified && <span className={s.unverified}>{t("uiAddressField.unverified")}</span>}
          <button type="button" className="btn btn--ghost" onClick={() => onChange(null)}>{t("uiAddressField.change")}</button>
        </div>
        {compare}
        <Field label={t("uiAddressField.detail")} required={false} example={t("uiAddressField.detailExample")} error={error}>
          {(p) => <TextInput {...p} maxLength={100} value={value.detail} onChange={(e) => onChange({ ...value, detail: e.target.value })} />}
        </Field>
        {!value.verified && children}
      </div>
    );
  if (typing) return <Manual label={label} required={required} onDone={onChange} unavailable={problem === "unavailable"} compare={compare} onSearch={problem === "unavailable" ? undefined : () => setManual(false)} />;
  return (
    <div className={s.wrap}>
      <ComboBox className={`field ${css.picker}`} items={hits} inputValue={query} onInputChange={onQueryChange} onSelectionChange={(k) => {
        const h = hits.find((x) => x.key === k);
        if (h) onChange({ key: h.key, road: h.road, jibun: h.jibun, zip: h.zip, detail: "", verified: true });
      }} menuTrigger="input" allowsEmptyCollection isRequired={required} isInvalid={error != null}>
        <Label className={fieldCss.label}>{label}<Marker required={required} /></Label>
        <div className={css.input}>
          <Search aria-hidden="true" className={css.icon} />
          <Input className="field__input" />
        </div>
        <Popover className={`popover ${css.pop}`}>
          <ListBox className="listbox" renderEmptyState={() => <div className={css.empty}>{loading ? t("uiAddressField.loading") : problem === "narrow" ? t("uiAddressField.narrow") : t("uiAddressField.none")}</div>}>
            {(h: AddressHit) => (
              <ListBoxItem id={h.key} textValue={h.road} className={`listbox__item ${css.option}`}>
                <span className={css.name}>{h.road}</span>
                <span className={css.code}>{h.zip}</span>
                <span className={css.sub}><span>{h.jibun}</span>{h.building && <span>{h.building}</span>}</span>
              </ListBoxItem>
            )}
          </ListBox>
        </Popover>
      </ComboBox>
      <span className={s.sub}>{problem === "narrow" ? t("uiAddressField.narrow") : t("uiAddressField.hint")}</span>
      {compare}
      {error != null && <p className={s.error}>{error}</p>}
      <button type="button" className={`link ${s.link}`} onClick={() => setManual(true)}>{t("uiAddressField.manual")}</button>
    </div>
  );
}

/** Manual entry while search is down: the road address and postcode as typed, marked as needing verification. */
function Manual({ label, required, onDone, unavailable, compare, onSearch }: {
  label: string;
  required: boolean;
  onDone: (v: AddressValue) => void;
  unavailable: boolean;
  compare: ReactNode;
  onSearch?: () => void;
}) {
  const [road, setRoad] = useState("");
  const [zip, setZip] = useState("");
  const ok = road.trim().length >= 5 && /^\d{5}$/.test(zip);
  return (
    <div className={s.wrap} role="group" aria-label={label}>
      <span className={fieldCss.label}>{label}<Marker required={required} /></span>
      {unavailable && <p className={s.note} role="status">{t("uiAddressField.unavailable")}</p>}
      <Field label={t("uiAddressField.road")} required example={t("uiAddressField.roadExample")}>
        {(p) => <TextInput {...p} value={road} onChange={(e) => setRoad(e.target.value)} />}
      </Field>
      <Field label={t("uiAddressField.zipLabel")} required>
        {(p) => <TextInput {...p} className="code" inputMode="numeric" maxLength={5} value={zip} onChange={(e) => setZip(e.target.value.replace(/\D/g, ""))} />}
      </Field>
      {compare}
      <span className={s.row}>
        <button type="button" className="btn" disabled={!ok} onClick={() => onDone({ road: road.trim(), zip, detail: "", verified: false })}>{t("uiAddressField.useManual")}</button>
        {!ok && <span className={s.sub}>{t("uiAddressField.manualNeeds")}</span>}
        {onSearch && <button type="button" className={`link ${s.link}`} onClick={onSearch}>{t("uiAddressField.backToSearch")}</button>}
      </span>
    </div>
  );
}
