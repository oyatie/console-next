// BW-15 unlock request states, shared by the lock page and Home.
/** An unlock request's state (BW-15) as the server sent it; expiry is never written, so a waiting one past its window reads as expired. */
export type RequestState = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "SUPERSEDED";
type Request = { status: RequestState; relockAt: string; canDecide: boolean };
export const requestState = (r: Request, now: number): RequestState => (r.status === "PENDING" && Date.parse(r.relockAt) <= now ? "EXPIRED" : r.status);

/**
 * The request an in-force lock shows: waiting, refused or expired. An approved one is the unlock itself (the lock
 * left the list of locks in force), and a superseded one is never the latest.
 */
export const shownRequest = <R extends Request>(l: { unlockRequest?: R }, now: number): R | undefined =>
  l.unlockRequest && ["PENDING", "REJECTED", "EXPIRED"].includes(requestState(l.unlockRequest, now)) ? l.unlockRequest : undefined;

/** Locks with a waiting unlock request the viewer may approve or refuse now (their Home queue). */
export const toDecide = <L extends { unlockRequest?: Request }>(locks: readonly L[], now: number): L[] =>
  locks.filter((l) => l.unlockRequest?.canDecide && requestState(l.unlockRequest, now) === "PENDING");
