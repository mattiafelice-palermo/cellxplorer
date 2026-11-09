import assert from "node:assert/strict";
import test from "node:test";
import { sourceLimitations, sourceLimitationFigureText } from "../src/sourceLimitations.ts";
import { withMprReadNotice } from "../src/features/analyses/editor/plotting/mprReadNotice.ts";
const source={kind:"exploratory_mpr",detail:"Cycle identity unverified",cell_id:1,source_id:3,file:"a.mpr"};
test("verified mode alone disappears; true limitations deduplicate by source",()=>{
  assert.deepEqual(sourceLimitations([{...source,scientific_interpretation:"verified"}]),[]);
  assert.equal(sourceLimitations([source,source,{...source,source_id:4}]).length,2);
  assert.equal(sourceLimitationFigureText([source,source]),"1 source: unverified cycle identity; cycle-based quantities unavailable");
});
test("figure notices preserve existing annotations and verified layouts unchanged",()=>{
  const layout={annotations:[{text:"Reference"}],margin:{t:20}};
  assert.equal(withMprReadNotice(layout,[{...source,scientific_interpretation:"verified"}]),layout);
  const result=withMprReadNotice(layout,[source]);
  assert.equal(result.annotations?.length,2);
  assert.equal(layout.annotations.length,1);
  assert.match(String(result.annotations?.[1].text),/cycle-based quantities unavailable/);
});
