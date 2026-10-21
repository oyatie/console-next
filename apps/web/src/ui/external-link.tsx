import type { ReactNode } from "react";

/** Source documents open beside the current task. */
export function ExternalLink({href,children}:{href:string;children:ReactNode}) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}
