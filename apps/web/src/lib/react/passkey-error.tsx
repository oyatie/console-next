import { ApiError } from "@console/api";
import { signInError } from "../refusal";
import { Banner } from "../../ui/banner/banner";
import { CommandError } from "./command-error";

/** A passkey ceremony failure: the server's reason, catalog copy for a browser refusal, nothing for a dismissed prompt. */
export function PasskeyError({ error, own }: { error: unknown; own?: (code: string) => string | undefined }) {
  if (!error) return null;
  if (error instanceof ApiError) return <CommandError error={error} own={own} />;
  const text = signInError(error);
  return text ? <Banner tone="danger" live="assertive">{text}</Banner> : null;
}
