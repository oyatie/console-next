import { t } from "@console/i18n";
import { Chip } from "../../../ui/chip";
import type { Mark } from "../api";
import { GLYPH, MARK_TONE } from "../domain/day";

const CHIP = { blocking: "danger", decision: "warn", info: "info" } as const;

/** A person-day mark as a glyph and its word (▲ blocks the close, ◆ needs a decision, ● for reference); never colour only. */
export function MarkChip({ mark }: { mark: Mark }) {
  const tone = MARK_TONE[mark];
  return <Chip tone={CHIP[tone]}><span aria-hidden>{GLYPH[tone]}</span> {t(`attendanceRecords.mark.${mark}`)}</Chip>;
}

/** The glyph alone with its word for a screen reader, for a dense cell. */
export function MarkGlyph({ mark }: { mark: Mark }) {
  const tone = MARK_TONE[mark];
  return <span title={t(`attendanceRecords.mark.${mark}`)}><span aria-hidden>{GLYPH[tone]}</span><span className="sr-only">{t(`attendanceRecords.mark.${mark}`)}</span></span>;
}
