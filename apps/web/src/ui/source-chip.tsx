import { t } from "@console/i18n";
import { Chip } from "./chip";

/** Where a field's value came from (design §7.4): read from the uploaded document, confirmed by the NTS, typed, a value kept from before, or entered at tenant opening. */
export type Source = "document" | "nts" | "manual" | "previous" | "opening";
const TONE = { document: "info", nts: "ok", manual: "neutral", previous: "neutral", opening: "neutral" } as const;

export const SourceChip = ({ source }: { source: Source }) => <Chip tone={TONE[source]}>{t(`uiSourceChip.${source}`)}</Chip>;
