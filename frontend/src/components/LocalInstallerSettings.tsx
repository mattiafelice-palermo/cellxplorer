import { Alert, Button, Group, Paper, Stack, Text, TextInput } from "@mantine/core";
import { IconFolderOpen } from "@tabler/icons-react";
import { useState } from "react";
import { canUseLocalInstaller, getCurrentRelease, normalizeUpdaterError } from "../appUpdater";
import { isTauriApp } from "../downloads";
import { useOptionalAppUpdate } from "./AppUpdateCoordinator";

export function LocalInstallerSettings() {
  const updater = useOptionalAppUpdate();
  const [installer, setInstaller] = useState("");
  const [signature, setSignature] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const native = isTauriApp();
  const disabled = !native || !updater || busy || !canUseLocalInstaller(updater.state);
  const local = updater && getCurrentRelease(updater.state)?.localInstaller
    ? getCurrentRelease(updater.state) : null;

  async function browse(kind: "installer" | "signature") {
    if (disabled) return;
    setBusy(true);
    setError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ multiple: false, directory: false,
        title: kind === "installer" ? "Select signed CellXplorer installer" : "Select matching updater signature",
        filters: [{ name: kind === "installer" ? "Windows installer" : "Updater signature", extensions: [kind === "installer" ? "exe" : "sig"] }],
      });
      if (typeof selected !== "string") return;
      if (kind === "installer") { setInstaller(selected); setSignature(`${selected}.sig`); }
      else setSignature(selected);
    } catch (cause) { setError(normalizeUpdaterError(cause, "Could not select the local file.")); }
    finally { setBusy(false); }
  }

  async function verify() {
    if (disabled || !updater || !installer.trim() || !signature.trim()) return;
    setBusy(true);
    setError(null);
    try { await updater.stageLocalInstaller(installer, signature); }
    catch (cause) { setError(normalizeUpdaterError(cause, "Could not verify the local installer.")); }
    finally { setBusy(false); }
  }

  async function discard() {
    if (disabled || !updater) return;
    setBusy(true);
    setError(null);
    try { await updater.discardLocalInstaller(); }
    catch (cause) { setError(normalizeUpdaterError(cause, "Could not discard the local candidate.")); }
    finally { setBusy(false); }
  }

  return <Paper withBorder p="md">
    <Stack gap="sm">
      <div>
        <Text fw={600}>Install from a local signed file</Text>
        <Text size="sm" c="dimmed">
          Test a manual installer through the automatic updater. Verification does not install it;
          the next dialog asks you to install. This is a real update or reinstall, not a simulation.
        </Text>
      </div>
      {!native ? <Text size="sm" c="dimmed">Available only in the installed Windows application.</Text> : null}
      <Group align="end" gap="xs">
        <TextInput label="Installer (.exe)" value={installer} disabled={disabled}
          onChange={(event) => { const value = event.currentTarget.value; setInstaller(value); setSignature(value ? `${value}.sig` : ""); setError(null); }}
          style={{ flex: "1 1 18rem", minWidth: 0 }} />
        <Button variant="default" disabled={disabled} onClick={() => void browse("installer")} leftSection={<IconFolderOpen size={16} />}>Browse installer</Button>
      </Group>
      <Group align="end" gap="xs">
        <TextInput label="Matching updater signature (.sig)" value={signature} disabled={disabled}
          onChange={(event) => { setSignature(event.currentTarget.value); setError(null); }}
          style={{ flex: "1 1 18rem", minWidth: 0 }} />
        <Button variant="default" disabled={disabled} onClick={() => void browse("signature")} leftSection={<IconFolderOpen size={16} />}>Browse signature</Button>
      </Group>
      <Text size="xs" c="dimmed">
        Both files must come from an official signed build. The app checks the signature, embedded
        product/channel and version. Same-version reinstall is allowed; downgrades are rejected.
        The selected file is copied into verified update state; changing it afterward cannot change the installation.
      </Text>
      {error ? <Alert color="red" title="Local installer not ready">{error}</Alert> : null}
      {local ? <Text size="sm">Local v{local.version} is staged. Automatic discovery is paused until you install or discard it.</Text> : null}
      <Group justify="flex-end" gap="xs">
        {local ? <Button variant="default" disabled={disabled} onClick={() => void discard()}>Discard local installer</Button> : null}
        <Button disabled={disabled || !installer.trim() || !signature.trim()} loading={busy} onClick={() => void verify()}>Verify local installer</Button>
      </Group>
    </Stack>
  </Paper>;
}
