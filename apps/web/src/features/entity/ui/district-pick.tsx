import { t } from "@console/i18n";
import type { AddrDraft } from "../domain/draft";
import { RefPick } from "./ref-pick";

/**
 * The district of an address typed by hand while the address search was down (design §5): picked from the
 * administrative-district list, it gives the address its codes until the address is matched again.
 */
export function DistrictPick({ a, onChange }: { a: AddrDraft | null; onChange: (a: AddrDraft) => void }) {
  if (!a || a.verified) return null;
  return <RefPick listKey="admin_region" qualified label={t("capture.field.district")} required={false} value={a.district ?? null} onChange={(district) => onChange({ ...a, district })}  />;
}
