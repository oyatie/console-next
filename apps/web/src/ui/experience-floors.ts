// SPDX-License-Identifier: LicenseRef-Proprietary
// The smallest text and the smallest control a style may draw, in px, on a desk and on a phone. Console's are the
// sizes its boards draw, as its owner ruled; a style with no entry keeps the first floor, 14 and 32 at every width.
const FLOORS: Record<string, Record<"desk" | "phone", { text: number; control: number }>> = {
  console: { desk: { text: 12, control: 24 }, phone: { text: 13, control: 44 } },
};

/** One table for every test that measures a style's rendered sizes, so two tests cannot hold two floors. */
export const floorOf = (experience: string, form: "desk" | "phone") => FLOORS[experience]?.[form] ?? { text: 14, control: 32 };
