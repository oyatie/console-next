// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { useCommand } from "./command";

test.each(["pending", "rejected"])("an applied command succeeds despite a %s success callback", async state => {
  const callback = Promise.withResolvers<void>();
  // The callback owns its rejection; the command must ignore its returned promise.
  void callback.promise.catch(() => undefined);
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  let command!: ReturnType<typeof useCommand<void, string>>;
  function Probe({ collect }: { collect: (value: typeof command) => void }) {
    collect(useCommand({ run: async () => "applied", onSuccess: () => callback.promise }));
    return null;
  }
  renderToStaticMarkup(<QueryClientProvider client={client}><Probe collect={value => { command = value; }} /></QueryClientProvider>);
  const done = command.mutateAsync();
  void done.catch(() => undefined);
  if (state === "rejected") callback.reject(new Error("destination unavailable"));
  try {
    await vi.waitFor(() => expect(client.getMutationCache().getAll()[0]!.state.status).toBe("success"));
    await expect(done).resolves.toBe("applied");
  } finally {
    callback.resolve();
    await done.catch(() => undefined);
    client.clear();
  }
});
