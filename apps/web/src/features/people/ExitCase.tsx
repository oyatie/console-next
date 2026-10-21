// Exit cases live in ui/exit-*; this path stays for the screens that import it (Home's exit queue, the
// employee page). New code imports from ui/ directly.
import { ExitCases } from "./ui/exit-block";
import { CaseFacts } from "./ui/exit-facts";

export { CaseFacts, ExitCases };
