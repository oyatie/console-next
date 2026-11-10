import type { ReactNode } from "react";

/** Source documents open beside the current task. */
export function ExternalLink({href,children,className}:{href:string;children:ReactNode;className?:string}) {
  return <a href={href} className={className} target="_blank" rel="noopener noreferrer">{children}</a>;
}
