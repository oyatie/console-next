// Work uses action-inbox; the greeting shares the ordinary identity query.
import { get } from "../../lib/query";
export const meQuery = get("/api/v1/users/me");
