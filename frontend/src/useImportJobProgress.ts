import { useQuery } from "@tanstack/react-query";

import { get, type BackgroundJob } from "./api";
import { importJobPollInterval } from "./importProgress";

export function useImportJobProgress(token: string | null, enabled: boolean) {
  return useQuery<BackgroundJob | null>({
    queryKey: ["import-background-job", token],
    queryFn: () => get<BackgroundJob | null>(`/api/background-jobs/by-token/${token}`),
    enabled: Boolean(token) && enabled,
    refetchInterval: (query) => importJobPollInterval(query.state.data),
  });
}
