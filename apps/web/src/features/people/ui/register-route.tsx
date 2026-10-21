import { getRouteApi } from "@tanstack/react-router";
import { Denied } from "../../../lib/react/denied";
import { useQuery } from "@tanstack/react-query";
import { authzQuery, granted } from "../../../reference/authz/api";
import { RegisterSheet } from "./register-sheet";

const route = getRouteApi("/app/people/new");

/** /people/new: the registration sheet over the roster; closing keeps the roster's filters. */
export function RegisterRoute() {
  const { unit } = route.useSearch();
  const navigate = route.useNavigate();
  // Registering is org-wide on the server: a caller without that grant is told so, never handed a form it refuses.
  const authz = useQuery(authzQuery);
  if (authz.isSuccess && !granted(authz.data.capabilities)("employee_directory_manage", "all")) return <Denied />;
  return (
    <RegisterSheet
      preset={unit}
      onClose={() => void navigate({ to: "/people", search: (prev) => prev })}
      onOpen={(id) => void navigate({ to: "/people/$id", params: { id }, search: {} })}
      onRehire={(id) => void navigate({ to: "/people/$id", params: { id }, search: { act: "rehire" } })}
    />
  );
}
