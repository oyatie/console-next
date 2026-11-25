// SPDX-License-Identifier: LicenseRef-Proprietary
import { modChord } from "./pure/keys";

/** `modChord` for the system this page runs on. Outside a page it reads Ctrl: Node has a navigator too, naming the machine a test runs on. */
export const modHint = (key: string) => modChord(key, typeof document === "undefined" ? undefined : navigator);
