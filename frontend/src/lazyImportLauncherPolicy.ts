export type LazyImportLauncherAction = "open" | "indexed";

export interface LazyImportLauncherState {
  mounted: boolean;
  pendingAction: LazyImportLauncherAction | null;
}

export function lazyImportLauncherInitialState(): LazyImportLauncherState {
  return { mounted: false, pendingAction: null };
}

export function triggerLazyImportAction(
  _state: LazyImportLauncherState,
  action: LazyImportLauncherAction,
): LazyImportLauncherState {
  return { mounted: true, pendingAction: action };
}

export function consumeLazyImportAction(
  state: LazyImportLauncherState,
): LazyImportLauncherState {
  if (state.pendingAction === null) return state;
  return { mounted: state.mounted, pendingAction: null };
}
