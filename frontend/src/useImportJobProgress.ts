import { useQuery } from "@tanstack/react-query";

import { get, type BackgroundJob } from "./api";

export function useImportJobProgress(token: string | null, enabled: boolean) {
  return useQuery<BackgroundJob | null>({
    queryKey: ["import-background-job", token],
    queryFn: () => get<BackgroundJob | null>(`/api/background-jobs/by-token/${token}`),
    enabled: Boolean(token) && enabled,
    refetchInterval: (query) =>
      query.state.data === null || query.state.data?.status === "running" ? 500 : false,
  });
}
