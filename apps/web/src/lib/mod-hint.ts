// SPDX-License-Identifier: LicenseRef-Proprietary
import { modChord } from "./pure/keys";

/** `modChord` for the system this page runs on. Outside a page (a server render) there is no navigator, and it reads Ctrl. */
export const modHint = (key: string) => modChord(key, typeof document === "undefined" ? undefined : navigator);
