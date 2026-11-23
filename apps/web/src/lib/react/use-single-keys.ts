// SPDX-License-Identifier: LicenseRef-Proprietary
import { useSyncExternalStore } from "react";
import { singleKeysOn, subscribeSingleKeys } from "../prefs";

/** The single-key choice for what is drawn: a shown key or an announced shortcut follows a change at once. */
export function useSingleKeys() {
  // A server render (print views, markup tests) reads the same stored value a client render does.
  return useSyncExternalStore(subscribeSingleKeys, singleKeysOn, singleKeysOn);
}
