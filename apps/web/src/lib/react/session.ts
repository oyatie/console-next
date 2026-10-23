// Route guards over the signed-in session: who may see sign-in, passkey set-up and the app.
import { redirect } from "@tanstack/react-router";
import { ApiError, consentStatus, logout, refresh, session } from "@console/api";

/** A session whose token and passkey state disagree cannot recover in place: sign out and sign in again. */
async function signInAgain(): Promise<never> {
  await logout();
  throw redirect({ to: "/login" });
}

const home = () => (session.claims?.platform ? "/platform" : "/");

/** A reload loses the in-memory access token; the refresh cookie restores it. */
export async function ensureSession({ location }: { location: { pathname: string } }) {
  // A session that ended in use stays on its screen under the re-auth dialog (auth/IdleGuard.tsx).
  if (session.lost) return;
  // A refresh that fails for a fault (network, 429, 5xx) rejects: the route's error screen offers a reload.
  if (!session.token && !(await refresh())) throw redirect({ to: "/login" });
  if (session.stage === "enroll") throw redirect({ to: "/setup-passkey" });
  if (session.stage === "stale") return signInAgain();
  if (session.stage === "app") {
    const status = await requiredConsentStatus();
    if (!status.accepted) throw redirect({ to: "/setup-passkey" });
  }
  // Vendor-tier tokens are refused by tenant routes and vice versa; send each tier home.
  // My account (own passkeys, language) serves both tiers.
  if (location.pathname === "/account") return;
  const platformPath = location.pathname.startsWith("/platform");
  if (session.claims?.platform && !platformPath) throw redirect({ to: "/platform" });
  if (!session.claims?.platform && platformPath) throw redirect({ to: "/" });
}

/** A signed-in session goes home instead of redeeming another principal's code over it. */
export function leaveSignInWhenSignedIn() {
  if (session.token && session.stage === "app") throw redirect({ to: home() });
}

/** Passkey set-up is only for a session that still has to enroll one or needs consent. */
export async function ensureEnrolling() {
  if (!session.token && !(await refresh())) throw redirect({ to: "/login" });
  if (session.stage === "app") {
    const status = await requiredConsentStatus();
    if (status.accepted) throw redirect({ to: home() });
  }
  if (session.stage === "stale") return signInAgain();
}

/** Unpublished documents keep users on setup, where they can retry or sign out. */
async function requiredConsentStatus() {
  try {
    return await consentStatus();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.code === "terms_not_published") return { accepted: false };
    throw error;
  }
}
