import type { components } from "@console/api/schema";
import { useCommand } from "../../../lib/react/command";
import { issueSignInCode } from "../api";

/** A one-time code to hand over: a first sign-in (invite) or the sign-in after a passkey reset. */
export type Issued = components["schemas"]["AdminIssueOtpResponse"] & { name: string; userId: string; reset?: boolean; signInId?: string | null };

/**
 * Issues a single-use sign-in code once the admin has confirmed it is them with their own passkey (step-up).
 * Org-wide targets omit the branch. The code is dropped from memory once handed on.
 */
export function useIssueCode(onIssued: (r: Issued) => void) {
  return useCommand({
    run: async ({ id, name, branch, signInId }: { id: string; name: string; branch?: string; signInId?: string | null }): Promise<Issued> => ({
      name,
      userId: id,
      signInId,
      ...(await issueSignInCode(id, branch)),
    }),
    invalidates: ["/api/v1/directory", "/api/v1/users"],
    onSuccess: onIssued,
    forget: true,
  });
}
