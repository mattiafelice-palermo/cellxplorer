import { Accordion, Alert, Button, Group, Highlight, List, Paper, Stack, Text, Title } from "@mantine/core";
import { IconArrowLeft, IconArrowRight, IconFile, IconFolder, IconPlayerPlay, IconSearch } from "@tabler/icons-react";
import { useState } from "react";

import styles from "./SearchIntroduction.module.css";

/** Static example, not a catalog result: no source access or indexing during onboarding. */
export function SearchIntroduction({ onClose, onChooseFolders, reducedMotion }: {
  onClose: () => void; onChooseFolders: () => void; reducedMotion: boolean;
}) {
  const [watching, setWatching] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  return <Stack gap="lg" className={styles.surface}>
    <div className={`${styles.work} cx-vertical-scroll`} role="region" aria-label="File search introduction" tabIndex={0}><Stack gap="lg">
    <header className={styles.intro}>
      <Title order={2} className={styles.headline}>Find files. Skip the folder hunt.</Title>
      <Text size="md" c="dimmed" maw={620} mx="auto">Search your chosen folders and network drives by name or metadata.</Text>
    </header>

    {watching ? <Stack gap="xs">
      <Paper withBorder style={{ overflow: "hidden" }}>
        <video aria-label="File search walkthrough" src="/whats-new/indexed-search.mp4" poster="/whats-new/indexed-search-poster.jpg" controls muted playsInline autoPlay={!reducedMotion} preload="metadata" onError={() => setVideoFailed(true)} className={styles.video}>
          <track kind="captions" src="/whats-new/indexed-search.vtt" srcLang="en" label="English" default />
        </video>
      </Paper>
      {videoFailed && <Alert color="gray">The walkthrough could not play. The full guide below covers the same steps.</Alert>}
    </Stack> :
      <div className={styles.example} role="group" aria-label="Example: find an Alava file across cycling folders">
        <Paper withBorder p="lg" className={styles.folders}>
          <Group gap="xs" wrap="nowrap"><IconFolder size={22} aria-hidden /><Text fw={600}>Cycling</Text></Group>
          <div className={styles.tree}>
            {["LPMoL_511", "LPMoL_512", "LPMoL_513"].map((folder) => <Group key={folder} gap="xs" wrap="nowrap" className={styles.branch}><IconFolder size={18} aria-hidden /><Text size="sm">{folder}</Text></Group>)}
          </div>
        </Paper>
        <IconArrowRight size={28} className={styles.arrow} aria-hidden />
        <Stack gap="sm" className={styles.result}>
          <Paper withBorder p="sm" className={styles.query}><Group gap="sm" wrap="nowrap"><IconSearch size={22} aria-hidden /><Text size="lg" fw={500}>Alava</Text></Group></Paper>
          <Paper withBorder p="md">
            <Group gap="sm" wrap="nowrap" align="flex-start"><IconFile size={26} aria-hidden style={{ flexShrink: 0 }} /><Stack gap={4} style={{ minWidth: 0 }}>
              <Highlight highlight="Alava" className={styles.filename}>LPMoL_512_Alava_cycling.ndax</Highlight>
              <Text size="sm" c="dimmed">Network drive / Cycling / LPMoL_512</Text>
              <Text size="sm" c="dimmed">Matched filename: <Text span inherit c="var(--mantine-primary-color-filled)" fw={600}>Alava</Text></Text>
            </Stack></Group>
          </Paper>
        </Stack>
      </div>}
    <Button variant="subtle" size="md" aria-expanded={watching} leftSection={watching ? <IconArrowLeft size={20} /> : <IconPlayerPlay size={22} />} onClick={() => { setWatching((value) => !value); setVideoFailed(false); }} style={{ alignSelf: "center" }}>{watching ? "Back to example" : "See how it works"}</Button>

    <Accordion variant="default">
      <Accordion.Item value="guide"><Accordion.Control>Full guide</Accordion.Control><Accordion.Panel>
        <List type="ordered" spacing="sm" size="sm">
          <List.Item><strong>Choose your folders.</strong> Open Settings → File search, or Load cells → Search indexed locations → Locations. Choose Add search location and Index this folder. Local folders and network drives are supported.</List.Item>
          <List.Item><strong>Let the first index build.</strong> Indexing runs in the background; progress appears in Activity → Processing. Search uses a local catalog and your source files stay in place. Available change notifications keep it live; otherwise locations refresh on their configured schedule. Offline locations retain their last known results.</List.Item>
          <List.Item><strong>Find files.</strong> In Load cells → Search indexed locations, search a filename, folder, source-header detail or linked Cell information. Each result explains why it matched. “File header” means information written into the export; it is distinct from editable Cell names and notes.</List.Item>
          <List.Item><strong>Narrow the results.</strong> Use Filters for dates, size, source metadata, available cycling facts and Cell Database/analysis/replicate usage. Find a filter by typing its name or a synonym. Unavailable cycling facts remain unknown; search does not calculate them. Applied chips can be edited or removed. Save search retains the query, filters and ordering.</List.Item>
          <List.Item><strong>Preview and include.</strong> Click a result or use arrow keys to preview voltage, current, capacity and CE where available. Press Space or Ctrl-click to include a file. Checkbox inclusion keeps Filters open. Already-registered files remain previewable but cannot be imported again; Show in folder opens their location to find related files.</List.Item>
          <List.Item><strong>Review before importing.</strong> Continue through the existing loader steps to choose files and review Cells before saving. Cold previews and the initial index can take longer than catalog searches.</List.Item>
        </List>
      </Accordion.Panel></Accordion.Item>
    </Accordion>
    </Stack></div>
    <Group justify="space-between" gap="sm" className={styles.footer}>
      <Text size="sm" c="dimmed">The first index builds in the background.</Text>
      <Group gap="xs"><Button variant="default" onClick={onClose}>Later</Button><Button onClick={onChooseFolders}>Choose search folders</Button></Group>
    </Group>
  </Stack>;
}
