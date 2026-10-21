import { tg } from "@console/i18n/gallery";
import { ShiftBar } from "./shift-bar";

export const order = 159;

/** A stay past the shift (hatched, not recognised), a day in order, and a clock-in with no clock-out. */
export default function ShiftBarGallery() {
  const plan = [{ start: 480, end: 720 }, { start: 780, end: 1020 }];
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.shiftBar")}</h2>
      <ShiftBar from={360} to={1260} scheduled={plan} recorded={[{ start: 472, end: 1150 }]} recognised={plan} />
      <ShiftBar from={360} to={1260} scheduled={plan} recorded={[{ start: 476, end: 1024 }]} recognised={plan} />
      <ShiftBar from={360} to={1260} scheduled={plan} recorded={[]} recognised={[]} open={472} />
    </section>
  );
}
