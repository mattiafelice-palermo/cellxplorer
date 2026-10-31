import assert from "node:assert/strict";
import test from "node:test";
import { canAutoUseOnlyInstalledEdition, editionAvailability, mockBetaBootstrapStatus, type InstalledEdition } from "../src/betaBootstrapPolicy.ts";

for (const channel of ["alpha", "beta"] as const) {
  test(`${channel}: automatic setup requires complete positive single-edition evidence`, () => {
    const status = mockBetaBootstrapStatus("existing", channel);
    const editions: InstalledEdition[] = (["stable", "beta", "alpha"] as const).map((edition) => ({ channel: edition, availability: edition === channel ? "installed" : "absent" }));
    const args = { channel, editions, status, statusError: false, busy: false };
    assert.equal(canAutoUseOnlyInstalledEdition(args), true);
    assert.equal(canAutoUseOnlyInstalledEdition({ ...args, editions: undefined }), false);
    assert.equal(canAutoUseOnlyInstalledEdition({ ...args, editions: editions.slice(1) }), false);
    assert.equal(canAutoUseOnlyInstalledEdition({ ...args, statusError: true }), false);
    assert.equal(canAutoUseOnlyInstalledEdition({ ...args, busy: true }), false);
    assert.equal(canAutoUseOnlyInstalledEdition({ ...args, status: { ...status, outstandingStageToken: "staged" } }), false);
    assert.equal(canAutoUseOnlyInstalledEdition({ ...args, status: { ...status, applyFailureMessage: "Previous failure" } }), false);
    assert.equal(canAutoUseOnlyInstalledEdition({ ...args, status: { ...status, setupError: "Invalid" } }), false);
    assert.equal(canAutoUseOnlyInstalledEdition({ ...args, status: { ...status, scientificPreparationPending: true } }), false);
    for (const availability of ["installed", "unknown"] as const) {
      assert.equal(canAutoUseOnlyInstalledEdition({ ...args, editions: editions.map((edition) => edition.channel === "stable" ? { ...edition, availability } : edition) }), false);
    }
    assert.equal(editionAvailability(undefined, "stable"), "unknown");
  });
}
