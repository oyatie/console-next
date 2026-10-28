// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";

export const spreadsheetCases = JSON.parse(readFileSync(new URL("./spreadsheet-cell-cases.json", import.meta.url), "utf8")) as {
  value: string;
  neutralized: boolean;
  csv: string;
}[];

export const formulaCases = spreadsheetCases.filter((entry) => entry.neutralized);
