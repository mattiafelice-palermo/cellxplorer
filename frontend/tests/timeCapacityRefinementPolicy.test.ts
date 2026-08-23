import assert from "node:assert/strict";
import test from "node:test";

import type { TimeCapacityRefinementResult, TimeCapacityResult } from "../src/api.ts";
import {
  timeCapacityCycleRangeForViewport,
  timeCapacityOverviewExtent,
  timeCapacityRefinementCanSchedule,
  timeCapacityRefinementDisplayIsCompatible,
  timeCapacityRefinementDisplayIsCurrent,
  timeCapacityRefinementEligible,
  timeCapacityRefinementRequestIsCurrent,
  timeCapacityRefinementResultMatchesOverview,
  timeCapacityRefinementTransitionDuration,
  timeCapacityRefinementTransitionProgress,
  timeCapacityRefinementWorthwhile,
  timeCapacityViewportContains,
} from "../src/features/analyses/editor/families/time-capacity/timeCapacityRefinementPolicy.ts";

function result(): TimeCapacityResult {
  return {
    data_signature: "overview",
    computed_at: "now",
    type: "cycling",
    parser_version: "parser",
    calc_version: "calc",
    current_parser_version: "parser",
    current_calc_version: "calc",
    settings: {} as TimeCapacityResult["settings"],
    cell_traces: [
      {
        cell_id: 1,
        cell_name: "Cell 1",
        label: "Cell 1",
        group_id: null,
        group_name: null,
        excluded: false,
        active_mass_mg: null,
        nominal_capacity_mah: null,
        electrode_area_cm2: null,
        cycle: [1, 1, 2, 2, 3],
        display_x: [0, 1, 2, 3, 4],
        time_s: [],
        capacity_mah: [],
        capacity_mah_g: [],
        voltage_v: [3, 3, 3, 3, 3],
        current_ma: [1, 1, 1, 1, 1],
        phase: [],
        status: [],
        derivative_x: [],
        derivative_y: [],
      },
      {
        cell_id: 2,
        cell_name: "Hidden",
        label: "Hidden",
        group_id: null,
        group_name: null,
        excluded: true,
        active_mass_mg: null,
        nominal_capacity_mah: null,
        electrode_area_cm2: null,
        cycle: [99],
        display_x: [100],
        time_s: [],
        capacity_mah: [],
        capacity_mah_g: [],
        voltage_v: [3],
        current_ma: [1],
        phase: [],
        status: [],
        derivative_x: [],
        derivative_y: [],
      },
    ],
    badges: [],
  };
}

test("overview extent and cycle range use visible overview points only", () => {
  const current = result();
  assert.deepEqual(timeCapacityOverviewExtent(current), { min: 0, max: 4 });
  assert.deepEqual(
    timeCapacityCycleRangeForViewport(current, { min: 1.5, max: 3.5 }),
    { start: 1, end: 3 },
  );
});

test("refinement triggers at the half-span boundary but not for the full view", () => {
  const overview = { min: 0, max: 100 };
  assert.equal(timeCapacityRefinementWorthwhile(overview, { min: 25, max: 75 }), true);
  assert.equal(timeCapacityRefinementWorthwhile(overview, { min: 0, max: 100 }), false);
});

test("stale refinement identity and generation are rejected", () => {
  const current = result();
  const response = {
    ...current,
    data_signature: "overview",
    overview_data_signature: "overview",
    request_generation: "g1",
  } as TimeCapacityRefinementResult;
  assert.equal(timeCapacityRefinementRequestIsCurrent(response, current, "g1"), true);
  assert.equal(timeCapacityRefinementRequestIsCurrent(response, current, "g2"), false);
  assert.equal(timeCapacityRefinementResultMatchesOverview(response, current), true);
  response.overview_data_signature = "other";
  assert.equal(timeCapacityRefinementRequestIsCurrent(response, current, "g1"), false);
  assert.equal(timeCapacityRefinementResultMatchesOverview(response, current), false);
});

test("a compatible refined view remains while the next zoom request is pending", () => {
  const current = result();
  const response = {
    ...current,
    data_signature: "overview",
    overview_data_signature: "overview",
    request_generation: "g1",
  } as TimeCapacityRefinementResult;
  const displayedViewport = { min: 0, max: 100 };
  const nextViewport = { min: 25, max: 75 };

  assert.equal(timeCapacityRefinementRequestIsCurrent(response, current, "g2"), false);
  assert.equal(
    timeCapacityRefinementDisplayIsCompatible(
      response,
      current,
      displayedViewport,
      nextViewport,
    ),
    true,
  );
});

test("rapid zoom generations cannot let a late response replace the newest one", () => {
  const current = result();
  const responseB = {
    ...current,
    data_signature: "overview",
    overview_data_signature: "overview",
    request_generation: "g2",
  } as TimeCapacityRefinementResult;
  const responseC = { ...responseB, request_generation: "g3" };

  assert.equal(timeCapacityRefinementRequestIsCurrent(responseB, current, "g3"), false);
  assert.equal(timeCapacityRefinementRequestIsCurrent(responseC, current, "g3"), true);
});

test("autorange, semantic changes, and uncovered pans cannot retain a refinement", () => {
  const current = result();
  const response = {
    ...current,
    data_signature: "overview",
    overview_data_signature: "overview",
    request_generation: "g1",
  } as TimeCapacityRefinementResult;

  assert.equal(timeCapacityRefinementDisplayIsCompatible(response, current, { min: 0, max: 100 }, null), false);
  assert.equal(
    timeCapacityRefinementDisplayIsCompatible(response, current, { min: 0, max: 100 }, { min: -10, max: 50 }),
    false,
  );
  assert.equal(
    timeCapacityRefinementDisplayIsCompatible(
      response,
      { ...current, data_signature: "changed" },
      { min: 0, max: 100 },
      { min: 25, max: 75 },
    ),
    false,
  );
  assert.equal(timeCapacityViewportContains({ min: 0, max: 100 }, { min: 25, max: 75 }), true);
});

test("refinement transition is bounded and reduced-motion safe", () => {
  const duration = timeCapacityRefinementTransitionDuration(false);
  assert.ok(duration >= 100 && duration <= 180);
  assert.equal(timeCapacityRefinementTransitionDuration(true), 0);
  assert.equal(timeCapacityRefinementTransitionProgress(0, duration), 0);
  assert.equal(timeCapacityRefinementTransitionProgress(duration / 2, duration), 0.5);
  assert.equal(timeCapacityRefinementTransitionProgress(duration, duration), 1);
  assert.equal(timeCapacityRefinementTransitionProgress(10, 0), 1);
});

test("ordinary default spec is eligible and unsafe refinement modes are not", () => {
  const base = { computation: { time_capacity: undefined } } as never;
  assert.equal(timeCapacityRefinementEligible(base), true);
  assert.equal(
    timeCapacityRefinementEligible({
      computation: { time_capacity: { view: "voltage_current", x_axis: "capacity_mah" } },
    } as never),
    false,
  );
  assert.equal(
    timeCapacityRefinementEligible({
      computation: { time_capacity: { view: "voltage_current", x_axis: "time", stacked: true } },
    } as never),
    false,
  );
  assert.equal(
    timeCapacityRefinementEligible({
      computation: { time_capacity: { view: "voltage_current", x_axis: "time", cycles: [1, 10] } },
    } as never),
    false,
  );
});

test("stacked mode cannot display a previously accepted flat refinement", () => {
  const current = result();
  const response = {
    ...current,
    data_signature: "overview",
    overview_data_signature: "overview",
    request_generation: "g1",
  } as TimeCapacityRefinementResult;
  const flat = {
    computation: {
      time_capacity: { view: "voltage_current", x_axis: "time", display_mode: "consecutive" },
    },
  } as never;
  const stacked = {
    computation: {
      time_capacity: {
        view: "voltage_current",
        x_axis: "time",
        display_mode: "consecutive",
        stacked: true,
      },
    },
  } as never;

  assert.equal(
    timeCapacityRefinementDisplayIsCurrent(flat, response, current, "compat", "compat"),
    true,
  );
  assert.equal(
    timeCapacityRefinementDisplayIsCurrent(stacked, response, current, "compat", "compat"),
    false,
  );
});

test("inactive keep-mounted Time/Capacity cannot schedule refinement", () => {
  const base = { computation: { time_capacity: undefined } } as never;
  assert.equal(timeCapacityRefinementCanSchedule(true, base), true);
  assert.equal(timeCapacityRefinementCanSchedule(false, base), false);
});

test("tab-change generation invalidates a pending in-flight response", () => {
  const current = result();
  const response = {
    ...current,
    data_signature: "overview",
    overview_data_signature: "overview",
    request_generation: "g1",
  } as TimeCapacityRefinementResult;
  assert.equal(timeCapacityRefinementRequestIsCurrent(response, current, "g1"), true);
  // cancelRefinement advances the generation when the keep-mounted card goes
  // inactive; a late response from the old timer/request cannot replace it.
  assert.equal(timeCapacityRefinementRequestIsCurrent(response, current, "g2"), false);
});
