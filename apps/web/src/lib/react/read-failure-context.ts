// SPDX-License-Identifier: LicenseRef-Proprietary
import { createContext } from "react";

/** A main read card owns recovery when a shell read fails alongside it. */
export const ReadFailureContext = createContext<{
  register: () => () => void;
  retry: () => void;
} | null>(null);
