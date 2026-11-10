import test from "node:test";
import assert from "node:assert/strict";
import { cycleAvailability } from "../src/features/analyses/editor/families/cycles/cycleAvailability.ts";
import type { AnalysisSpec, ComputeResult } from "../src/api.ts";
const spec = {selection:{entries:[{kind:"cell",ref_id:1}],exclusions:[]},presentation:{quantity:"energy_throughput"}} as unknown as AnalysisSpec;
const result = {quantities:[{key:"energy_throughput",column:"energy_throughput_mwh"}],cell_series:[{cell_id:1,group_id:null,excluded:false,fec_reference_mah:null,quantities:{energy_throughput_mwh:[null,null],capacity_throughput_mah:[2,4]}}]} as unknown as ComputeResult;
test("missing nominal reference disables FEC independently of missing energy",()=>{
 const state=cycleAvailability(result,spec); assert.equal(state.fecDisabled,true); assert.match(state.fecReason!,/nominal capacity/); assert.match(state.energyReason!,/independent/);
 const withRef=structuredClone(result);withRef.cell_series[0].fec_reference_mah=10;
 assert.equal(cycleAvailability(withRef,spec).fecDisabled,false);assert.ok(cycleAvailability(withRef,spec).energyReason);
 const withEnergy=structuredClone(result);withEnergy.cell_series[0].quantities.energy_throughput_mwh=[1,2];
 assert.equal(cycleAvailability(withEnergy,spec).energyReason,null);assert.equal(cycleAvailability(withEnergy,spec).fecDisabled,true);
});
test("pending results do not disable FEC or invent missing-energy conclusions",()=>{assert.equal(cycleAvailability(undefined,spec).fecDisabled,false);assert.equal(cycleAvailability(undefined,spec).energyReason,null);});
