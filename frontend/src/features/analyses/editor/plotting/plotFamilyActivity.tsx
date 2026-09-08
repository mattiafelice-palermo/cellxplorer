import { createContext, useContext, useEffect } from "react";
import { estimatedPreloadedViewMemoryBytes } from "../policies/analysisFamilyRetention";

export type PlotFamilyActivity = {
  enabled: boolean;
  cacheOnly: boolean;
  onSettled?: (estimatedBytes?: number) => void;
};

export const PlotFamilyActivityContext = createContext<PlotFamilyActivity>({
  enabled: true,
  cacheOnly: false,
});

export function usePlotFamilyActivity() {
  return useContext(PlotFamilyActivityContext);
}

/** A speculative view releases its single preparation slot on success or miss. */
export function usePlotFamilyQuerySettled(query: {
  isSuccess: boolean;
  isError: boolean;
  isFetching: boolean;
  data?: unknown;
}) {
  const activity = usePlotFamilyActivity();
  useEffect(() => {
    if (activity.cacheOnly && !query.isFetching && (query.isSuccess || query.isError)) {
      activity.onSettled?.(estimatedPreloadedViewMemoryBytes(query.isSuccess ? query.data : undefined));
    }
  }, [activity, query.data, query.isError, query.isFetching, query.isSuccess]);
}
