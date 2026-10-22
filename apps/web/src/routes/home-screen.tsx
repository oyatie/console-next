import { Home } from "../features/home/Home";
import { SetupHome } from "../features/onboarding/ui/setup-home";

/** Setup and operating work share the same server queue. */
export function HomeScreen() {
  return <Home setup={(c) => <SetupHome c={c} />} />;
}
