// Korean copy for `format.` ids. Rules: the header of ../ko.ts and packages/i18n/GUIDE.md.
import type { enFormat } from "../en/format";
export const koFormat: Record<keyof typeof enFormat, string> = {
  "format.notComputable": "산정 불가",
  "format.krw": "{amount, number}원",
};