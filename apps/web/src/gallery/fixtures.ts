import { ApiError } from "@console/api";
import { tg } from "@console/i18n/gallery";

/** A 500 shared by the screen-state and command-error entries (built per render: copy follows the locale). */
export const failure = () => new ApiError(500, "internal", tg("error.message"), [], "op_01JGALLERY0000000000000001");
