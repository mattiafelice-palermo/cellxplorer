import { createContext, useContext, useEffect } from "react";

export type PlotFamilyActivity = {
  enabled: boolean;
  cacheOnly: boolean;
  onSettled?: () => void;
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
}) {
  const activity = usePlotFamilyActivity();
  useEffect(() => {
    if (activity.cacheOnly && !query.isFetching && (query.isSuccess || query.isError)) {
      activity.onSettled?.();
    }
  }, [activity, query.isError, query.isFetching, query.isSuccess]);
}
