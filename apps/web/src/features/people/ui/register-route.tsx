import { getRouteApi } from "@tanstack/react-router";
import { RegisterSheet } from "./register-sheet";

const route = getRouteApi("/app/people/new");

/** /people/new: the registration sheet over the roster; closing keeps the roster's filters. */
export function RegisterRoute() {
  const { unit } = route.useSearch();
  const navigate = route.useNavigate();
  // PeopleRoute checks the whole-tenant registration grant before mounting the sheet or the roster.
  return (
    <RegisterSheet
      preset={unit}
      onClose={() => void navigate({ to: "/people", search: (prev) => prev })}
      onOpen={(id) => void navigate({ to: "/people/$id", params: { id }, search: {} })}
      onRehire={(id) => void navigate({ to: "/people/$id", params: { id }, search: { act: "rehire" } })}
    />
  );
}
