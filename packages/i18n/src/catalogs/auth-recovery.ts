// SPDX-License-Identifier: LicenseRef-Proprietary
import { createT } from "../index";
import { enAuth } from "./en/auth";
import { koAuth } from "./ko/auth";

export const tr = createT({ en: enAuth, ko: koAuth });
