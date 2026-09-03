import assert from "node:assert/strict";
import test from "node:test";

import type { TimeCapacityRefinementResult, TimeCapacityResult } from "../src/api.ts";
import { TimeCapacityRefinementLifecycle } from "../src/features/analyses/editor/families/time-capacity/timeCapacityRefinementLifecycle.ts";
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
  timeCapacityVisibleCycleRangeForViewport,
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
  assert.deepEqual(
    timeCapacityVisibleCycleRangeForViewport(current, { min: 1.5, max: 3.5 }),
    { start: 2, end: 2 },
  );
  assert.deepEqual(
    timeCapacityVisibleCycleRangeForViewport(current, { min: 3.5, max: 1.5 }),
    { start: 2, end: 2 },
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

test("ordinary and stacked Time/Capacity specs are eligible while unsafe modes are not", () => {
  const base = { computation: { time_capacity: undefined } } as never;
  assert.equal(timeCapacityRefinementEligible(base), true);
  assert.equal(
    timeCapacityRefinementEligible({
      computation: { time_capacity: { view: "voltage_current", x_axis: "capacity_mah" } },
    } as never),
    true,
  );
  assert.equal(
    timeCapacityRefinementEligible({
      computation: { time_capacity: { view: "voltage_current", x_axis: "time", stacked: true } },
    } as never),
    true,
  );
  assert.equal(
    timeCapacityRefinementEligible({
      computation: { time_capacity: { view: "voltage_current", x_axis: "time", cycles: [1, 10] } },
    } as never),
    false,
  );
});

test("flat and stacked renderers can display the same accepted refinement", () => {
  const current = result();
  const response = {
    ...current,
    data_signature: "overview",
    overview_data_signature: "overview",
    request_generation: "g1",
  } as TimeCapacityRefinementResult;
  assert.equal(
    timeCapacityRefinementDisplayIsCurrent(response, current, "compat", "compat"),
    true,
  );
});

test("production refinement lifecycle schedules, accepts, retains, and invalidates displays", () => {
  const current = result();
  const lifecycle = new TimeCapacityRefinementLifecycle();
  const responseFor = (generation: string): TimeCapacityRefinementResult => ({
    ...current,
    data_signature: "overview",
    overview_data_signature: "overview",
    request_generation: generation,
  });
  const viewportA = { min: 0, max: 100 };
  const viewportB = { min: 25, max: 75 };
  const viewportC = { min: 35, max: 65 };

  lifecycle.cancelPending();
  const generationA = lifecycle.beginRequest(viewportA);
  assert.equal(
    lifecycle.acceptResponse(responseFor(generationA), current, generationA, viewportA, "compat"),
    true,
  );

  lifecycle.cancelPending();
  const generationB = lifecycle.beginRequest(viewportB);
  assert.equal(lifecycle.displayed?.viewport.max, 100);

  lifecycle.cancelPending();
  const generationC = lifecycle.beginRequest(viewportC);
  assert.equal(
    lifecycle.acceptResponse(responseFor(generationB), current, generationB, viewportB, "compat"),
    false,
  );
  assert.equal(lifecycle.displayed?.result.request_generation, generationA);
  assert.equal(
    lifecycle.acceptResponse(responseFor(generationC), current, generationC, viewportC, "compat"),
    true,
  );
  assert.equal(lifecycle.displayed?.result.request_generation, generationC);

  lifecycle.invalidate();
  assert.equal(lifecycle.displayed, null);
  const freshGeneration = lifecycle.beginRequest(viewportC);
  assert.equal(
    lifecycle.acceptResponse(
      responseFor(freshGeneration),
      current,
      freshGeneration,
      viewportC,
      "compat",
    ),
    true,
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
