// SPDX-License-Identifier: LicenseRef-Proprietary
import { createContext } from "react";

export const PageScope = createContext({ landmark: false, embedded: false });
export const PageHeadingLevel = createContext<1 | 2>(1);
