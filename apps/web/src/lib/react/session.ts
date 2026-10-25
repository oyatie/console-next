// Route guards over the signed-in session: who may see sign-in, passkey set-up and the app.
import { notFound, redirect } from "@tanstack/react-router";
import { logout, refresh, session } from "@console/api";

/** A session whose token and passkey state disagree cannot recover in place: sign out and sign in again. */
async function signInAgain(): Promise<never> {
  await logout();
  throw redirect({ to: "/login" });
}

const home = () => (session.claims?.platform ? "/platform" : "/");
let interrupted: { principal: string | null; href: string } | null = null;
/** The current account resumes the URL interrupted by consent, including its search and fragment. */
export const consentDestination = () => interrupted?.principal === session.principal ? interrupted.href : home();

/** A reload loses the in-memory access token; the refresh cookie restores it. */
export async function ensureSession({ location }: { location: { pathname: string; href?: string } }) {
  // A session that ended in use stays on its screen under the re-auth dialog (auth/IdleGuard.tsx).
  if (session.lost) return;
  // Cold restoration runs inside the shell, including held or failed refreshes.
  if (!session.token) return;
  if (session.stage === "enroll") throw redirect({ to: "/setup-passkey" });
  if (session.stage === "stale") return signInAgain();
  if (session.stage === "app" && !session.consentAccepted) {
    interrupted = { principal: session.principal, href: location.href ?? location.pathname };
    throw redirect({ to: "/setup-passkey" });
  }
  interrupted = null;
  // Vendor-tier tokens are refused by tenant routes and vice versa; send each tier home.
  // My account (own passkeys, language) serves both tiers.
  if (location.pathname === "/account") return;
  const platformPath = location.pathname.startsWith("/platform");
  if (session.claims?.platform && !platformPath) throw redirect({ to: "/platform" });
  if (!session.claims?.platform && platformPath) throw notFound();
}

/** A signed-in session goes home instead of redeeming another principal's code over it. */
export function leaveSignInWhenSignedIn() {
  if (session.token && session.stage === "app") throw redirect({ to: home() });
}

/** Passkey set-up is only for a session that still has to enroll one or needs consent. */
export async function ensureEnrolling() {
  if (!session.token && !(await refresh())) throw redirect({ to: "/login" });
  if (session.stage === "app" && session.consentAccepted) throw redirect({ to: home() });
  if (session.stage === "stale") return signInAgain();
}
