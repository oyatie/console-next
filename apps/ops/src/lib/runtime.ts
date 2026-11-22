// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient } from "@tanstack/react-query";
import { OpsLiveController } from "./live-sse";

export const opsQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: false,
      staleTime: Infinity,
    },
  },
});

export const opsLiveController = new OpsLiveController(opsQueryClient);
