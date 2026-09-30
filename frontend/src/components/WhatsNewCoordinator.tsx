import { Accordion, Alert, Button, Group, List, Modal, Paper, Stack, Text, Title } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { IconSearch } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

import { get } from "../api";
import { APP_CHANNEL } from "../appChannel";
import { isTauriApp } from "../downloads";
import { isAfterSearchIntroBaseline, markSearchIntroSeen, searchIntroWasSeen } from "../whatsNew";
import { useOptionalAppUpdate } from "./AppUpdateCoordinator";

export function WhatsNewCoordinator({ opened, onOpen, onClose, onTrySearch, ready, version }: {
  opened: boolean; onOpen: () => void; onClose: () => void; onTrySearch: () => void;
  ready: boolean; version: string | null;
}) {
  const desktop = isTauriApp();
  const packaged = desktop && !import.meta.env.DEV;
  const reducedMotion = useReducedMotion();
  const updates = useOptionalAppUpdate();
  const shown = useRef(false);
  const [videoFailed, setVideoFailed] = useState(false);
  useEffect(() => { if (opened) setVideoFailed(false); }, [opened]);
  // Reuse the bootstrap coordinator's query: never announce a feature over first-launch setup.
  const bootstrap = useQuery({
    queryKey: [`${APP_CHANNEL}-bootstrap-status`],
    queryFn: () => get<{ setupState?: string; needsChoice: boolean; blockingReason: string | null }>(`/api/${APP_CHANNEL}-bootstrap/status`),
    enabled: desktop && APP_CHANNEL !== "stable" && ready,
    staleTime: Infinity,
    retry: 1,
  });
  const setupComplete = APP_CHANNEL === "stable" || (bootstrap.data?.setupState === "complete" && !bootstrap.data.needsChoice && !bootstrap.data.blockingReason);
  useEffect(() => {
    if (!packaged || !ready || !setupComplete || !version || !isAfterSearchIntroBaseline(version) ||
      opened || updates?.modalOpen || shown.current || searchIntroWasSeen(window.localStorage)) return;
    // Wait for any existing dialog to close; never interrupt an import or setup decision.
    const announce = () => {
      if (document.querySelector('[role="dialog"]')) return;
      shown.current = true;
      observer.disconnect();
      onOpen();
    };
    const observer = new MutationObserver(announce);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setTimeout(announce, 350);
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [packaged, ready, setupComplete, version, opened, updates?.modalOpen, onOpen]);
  const close = () => {
    shown.current = true;
    if (packaged && version && isAfterSearchIntroBaseline(version)) markSearchIntroSeen(window.localStorage);
    onClose();
  };
  return <Modal opened={opened} onClose={close} title="What’s new" size="xl" centered>
    <Stack gap="sm">
      <Group gap="xs"><IconSearch size={20} /><Title order={4}>Find source files across your folders</Title></Group>
      <Text size="sm">Search your chosen folders, including network drives. Find files by name or source-header details, then preview and select them in the loader.</Text>
      <Paper withBorder p={0} style={{ overflow: "hidden" }}>
        {opened && <video key="search-tour" aria-label="File search walkthrough: open Load cells, select Search indexed locations, search, then preview a result" src="/whats-new/indexed-search.mp4" poster="/whats-new/indexed-search-poster.jpg" controls muted playsInline autoPlay={!reducedMotion} preload="metadata" onError={() => setVideoFailed(true)} style={{ display: "block", width: "100%", aspectRatio: "16 / 9", maxHeight: "42vh", objectFit: "contain", background: "var(--mantine-color-default)" }}><track kind="captions" src="/whats-new/indexed-search.vtt" srcLang="en" label="English" default /></video>}
      </Paper>
      {videoFailed && <Alert color="gray">The walkthrough could not play. The quick guide below covers the same steps.</Alert>}
      <Accordion variant="default">
        <Accordion.Item value="guide"><Accordion.Control>Quick guide</Accordion.Control><Accordion.Panel>
          <List type="ordered" spacing="xs" size="sm">
            <List.Item>Open <strong>Load cells → Search indexed locations</strong>.</List.Item>
            <List.Item>Choose <strong>Locations → Add search location</strong>, browse to a folder, and select <strong>Index this folder</strong>. The first scan runs in the background.</List.Item>
            <List.Item>Search a filename, folder, barcode, remarks, part number, start time or technique. Each result explains what matched. “File header” means information written into the source export, not the editable Cell name or notes.</List.Item>
            <List.Item>Click or use arrow keys to preview. Press <strong>Space</strong> or <strong>Ctrl-click</strong> to include a file; then Continue through the existing import review. Registered files can be previewed but not imported again.</List.Item>
          </List>
          <Text size="xs" c="dimmed" mt="sm">Search uses a local catalog. Initial indexing and cold plot previews can take longer. Your files remain in place. Search settings are also available in Settings → File search.</Text>
        </Accordion.Panel></Accordion.Item>
      </Accordion>
      <Group justify="flex-end"><Button variant="default" onClick={close}>Done</Button><Button leftSection={<IconSearch size={16} />} onClick={() => { close(); onTrySearch(); }}>Try file search</Button></Group>
    </Stack>
  </Modal>;
}
