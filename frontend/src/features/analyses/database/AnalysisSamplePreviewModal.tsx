import { Alert, Center, Loader, Modal } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense } from "react";

import type { CellDetail, ReplicateGroupPreview } from "../../../api";
import { get } from "../../../api";

const CellDetailTabs = lazy(() =>
  import("../../../components/CellDetailTabs").then((module) => ({ default: module.CellDetailTabs })),
);
const ReplicatePreviewPanel = lazy(() =>
  import("../../../components/ReplicatePreviewPanel").then((module) => ({
    default: module.ReplicatePreviewPanel,
  })),
);

export type AnalysisSamplePreview = {
  kind: "cell" | "replicate";
  id: number;
  name: string;
} | null;

export function AnalysisSamplePreviewModal({
  selection,
  onClose,
}: {
  selection: AnalysisSamplePreview;
  onClose: () => void;
}) {
  const cell = useQuery({
    queryKey: ["cell", selection?.kind === "cell" ? selection.id : null],
    queryFn: () => get<CellDetail>(`/api/cells/${selection!.id}`),
    enabled: selection?.kind === "cell",
  });
  const replicate = useQuery({
    queryKey: ["replicate-preview", selection?.kind === "replicate" ? selection.id : null],
    queryFn: () =>
      get<ReplicateGroupPreview>(`/api/replicate-groups/${selection!.id}/preview`),
    enabled: selection?.kind === "replicate",
  });
  const activeQuery = selection?.kind === "cell" ? cell : replicate;

  return (
    <Modal
      opened={selection !== null}
      onClose={onClose}
      title={selection?.name ?? "Sample preview"}
      size={selection?.kind === "cell" ? "90rem" : "xl"}
    >
      {activeQuery.isLoading ? (
        <Center h={300}><Loader /></Center>
      ) : activeQuery.isError ? (
        <Alert color="red">Could not load this preview.</Alert>
      ) : selection?.kind === "cell" && cell.data ? (
        <Suspense fallback={<Center h={300}><Loader /></Center>}>
          <CellDetailTabs cell={cell.data} />
        </Suspense>
      ) : selection?.kind === "replicate" ? (
        <Suspense fallback={<Center h={300}><Loader /></Center>}>
          <ReplicatePreviewPanel title={selection.name} preview={replicate.data} />
        </Suspense>
      ) : null}
    </Modal>
  );
}
