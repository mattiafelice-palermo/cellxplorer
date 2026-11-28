import assert from "node:assert/strict";
import test from "node:test";
import { sourceLimitations, sourceLimitationFigureText, sourceDetailsHref, sourceWarningText } from "../src/sourceLimitations.ts";
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
  assert.deepEqual(result.annotations,layout.annotations);
  assert.deepEqual(result.margin,layout.margin);
  assert.equal(layout.annotations.length,1);
  assert.match(result.meta.cellxplorer_source_note,/cycle-based quantities unavailable/);
});
test("old and new BioLogic cycle warnings explain the consequence outside the graph", () => {
  const warning = {code:"biologic_quantity_unavailable",message:"GCPL cycles could not be fully verified. GCPL counter-increment flag semantics are outside the verified adapter contract"};
  const text = sourceWarningText(warning);
  assert.match(text,/instrument’s cycle numbers/);
  assert.equal(sourceWarningText({...warning, quantity:"cycles", message:"Internal reason"}), text);
  const badge = {...source, scientific_interpretation:"verified", limitations:[warning]};
  assert.equal(sourceLimitationFigureText([badge], {cellIds:[1],cycleBased:false}),null);
  assert.equal(sourceLimitationFigureText([badge], {cellIds:[1],cycleBased:true}),"1 source: "+text);
  assert.match(sourceLimitationFigureText([badge,{kind:"cycles_detected",cell_id:1,detail:""}],
    {cellIds:[1],cycleBased:true})!,/counted from the measured current/);
});
test("verified limitations survive while figure qualifications follow plotted sources and quantities",()=>{
  const verified={...source,scientific_interpretation:"verified",limitations:[{code:"biologic_mb_eis_exclusion",message:"EIS executions excluded",count:12}]};
  assert.equal(sourceLimitations([verified]).length,1);
  assert.match(sourceLimitationFigureText([verified],{cellIds:[1],cycleBased:false})!,/EIS executions excluded/);
  assert.equal(sourceLimitationFigureText([source],{cellIds:[2],cycleBased:true}),null);
  assert.equal(sourceLimitationFigureText([source],{cellIds:[1],cycleBased:false}),null);
});

test("source detail links retain source identity and support old badges",()=>{
 assert.equal(sourceDetailsHref({cell_id:7,source_id:23}),"/?cell=7&cellTab=files&sourceId=23");
 assert.equal(sourceDetailsHref({cell_id:7}),"/?cell=7&cellTab=files");
});
