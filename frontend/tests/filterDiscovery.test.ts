import assert from "node:assert/strict";
import test from "node:test";
import { DISCOVERY_FIELDS, discoverFilters } from "../src/filterDiscovery.ts";
const search = (q: string) => discoverFilters(q, DISCOVERY_FIELDS);
test("size reveals only the size field, not its neighbours or sort options", () => {
  assert.deepEqual(search("size").matches.map((match) => match.field.key), ["size"]);
  assert.deepEqual(search("size").matches[0].highlight, ["size"]);
});
test("section titles and operator vocabulary do not create matches", () => {
  for (const q of ["contains", "equal", "equals", "does not contain", "Dates and times", "Location and file", "saved searches"]) assert.equal(search(q).matches.length, 0, q);
  assert.ok(search("file").matches.every((match) => match.field.label.toLowerCase().includes("file") || match.option));
});
test("synonyms and plural forms explain the match, and direct matches stay highlighted", () => {
  const manufacturer = search("manufacturers").matches;
  assert.equal(manufacturer.length, 1);
  assert.equal(manufacturer[0].field.key, "supplier");
  assert.equal(manufacturer[0].kind, "synonym");
  assert.equal(manufacturer[0].term, "manufacturer");
  assert.equal(search("suppliers").matches[0].kind, "plural");
  assert.deepEqual(search("cycle").matches[0].highlight, ["cycles"]);
  assert.ok(search("analyses").matches.some((match) => match.field.key === "analysis_id"));
});
test("actual semantic options match their owning filter with provenance", () => {
  const neware = search("Neware").matches;
  assert.equal(neware.length, 1);
  assert.equal(neware[0].field.key, "supplier");
  assert.equal(neware[0].kind, "option");
  assert.equal(neware[0].option, true);
  assert.equal(neware[0].term, "Neware");
  const dynamic = discoverFilters("Bump study", [{ key: "analysis_id", category: "app", label: "Specific analysis", options: ["Bump study cells"] }]);
  assert.equal(dynamic.matches[0].kind, "option");
});
test("conservative typo fallback includes transpositions and shows a suggestion", () => {
  const typo = search("cycels");
  assert.equal(typo.matches.length, 1);
  assert.equal(typo.matches[0].field.key, "cycle_count");
  assert.equal(typo.matches[0].kind, "fuzzy");
  assert.equal(typo.suggestion, "Recorded source cycles");
  assert.equal(search("size").suggestion, null);
  assert.equal(search("xyz").matches.length, 0);
  assert.equal(search("unrelatedword").matches.length, 0);
});
test("empty discovery returns every control without annotations", () => {
  assert.equal(search(" ").matches.length, DISCOVERY_FIELDS.length);
  assert.ok(search("").matches.every((match) => !match.highlight.length && !match.option));
});

test("meaningful actual option names retain conjunctions and boolean words", () => {
  const fields = [{ key: "analysis_id", category: "app", label: "Specific analysis", options: ["Charge and discharge", "No pressure test"] }];
  assert.equal(discoverFilters("Charge and discharge", fields).matches[0].term, "Charge and discharge");
  assert.equal(discoverFilters("No pressure test", fields).matches[0].term, "No pressure test");
  for (const q of ["contains", "equals", "any", "yes", "no", "and"]) assert.equal(discoverFilters(q, fields).matches.length, 0);
});
test("option discovery can be limited to the formats actually offered", () => {
  const fields = DISCOVERY_FIELDS.map((field) => field.key === "extension" ? { ...field, options: [".ndax", ".mpr"] } : field);
  assert.equal(discoverFilters("xlsx", fields).matches.length, 0);
  assert.equal(discoverFilters("mpr", fields).matches[0].term, ".mpr");
  assert.equal(search("sze").matches[0].field.key, "size");
});
