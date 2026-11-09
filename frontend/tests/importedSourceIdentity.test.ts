import test from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { importedSourceLabel, renamedImportedCells, subscribeImportedCellNames } from "../src/importedSourceIdentity.ts";
test("multiple owners and detached registrations are explicit", () => {
  assert.match(importedSourceLabel([{id:1,name:"New name"},{id:2,name:"Other"}]), /New name.*Other/);
  assert.match(importedSourceLabel(), /no current cell association/);
});
test("existing library query changes refresh imported names without source reads", () => {
  const client = new QueryClient();
  let cells = [{id:1,name:"Old"}];
  const unsubscribe = subscribeImportedCellNames(client, names => { cells = renamedImportedCells(cells,names)!; });
  client.setQueryData(["cell",1],{id:1,name:"New"});
  assert.equal(cells[0].name,"New");
  client.setQueryData(["cells"],[{id:1,name:"Newest"}]);
  assert.equal(cells[0].name,"Newest");
  unsubscribe(); client.clear();
});
