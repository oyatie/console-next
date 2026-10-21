/** Whether a record read failed because the entity is not there for this reader (deleted, never was, or out of scope). */
export const entityGone = (error: unknown) => {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404 || status === 403;
};
