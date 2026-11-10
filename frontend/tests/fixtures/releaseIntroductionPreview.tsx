// Isolated production-component acceptance fixture. No backend or real library.
import "@mantine/core/styles.css";
import "../../src/app.css";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Group, MantineProvider, SegmentedControl, Stack, Text } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { WhatsNewCoordinator } from "../../src/components/WhatsNewCoordinator";
import { BetaBootstrapCoordinator } from "../../src/components/BetaBootstrapCoordinator";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Fixture() {
  const [opened, setOpened] = useState(true);
  const [scheme, setScheme] = useState<"light" | "dark">("light");
  const [zoom, setZoom] = useState("1");
  const [guideChosen, setGuideChosen] = useState(false);
  document.documentElement.style.setProperty("--cellxplorer-ui-zoom", zoom);
  const chooser = new URLSearchParams(window.location.search).has("mockAlphaBootstrap");
  return <MantineProvider forceColorScheme={scheme} theme={{ primaryColor: "violet", defaultRadius: "md" }}>
    <QueryClientProvider client={queryClient}><MemoryRouter>
      <Stack p="md">
        <Text>Synthetic acceptance fixture — no backend connected</Text>
        <Group><Button onClick={() => setOpened(true)}>Open What’s New</Button>
          <SegmentedControl aria-label="Preview theme" value={scheme} onChange={value => setScheme(value as "light" | "dark")} data={["light", "dark"]} />
          <SegmentedControl aria-label="Preview UI zoom" value={zoom} onChange={setZoom} data={[{ value: "0.7", label: "70%" }, { value: "1", label: "100%" }, { value: "1.6", label: "160%" }]} />
        </Group>
        {guideChosen && <Text>Search folder settings requested (isolated callback).</Text>}
      </Stack>
      {chooser ? <BetaBootstrapCoordinator backendReady={false} gateRequiredOnLaunch /> : <WhatsNewCoordinator opened={opened} onOpen={() => setOpened(true)} onClose={() => setOpened(false)} onTrySearch={() => setGuideChosen(true)} ready={false} version="0.29.0-alpha.1" />}
    </MemoryRouter></QueryClientProvider>
  </MantineProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
