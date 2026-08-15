import assert from "node:assert/strict";
import test from "node:test";

import type { CacheWarmupTask } from "../src/api.ts";
import {
  warmupAnalysisQueryKey,
  warmupAnalysisRevisionsMatch,
} from "../src/features/analyses/editor/policies/warmupIdentityPolicy.ts";

const task = (overrides: Partial<CacheWarmupTask> = {}): CacheWarmupTask => ({
  id: "analysis:plot:generation-1",
  analysis_id: 7,
  analysis_title: "Study",
  plot_id: "plot-1",
  plot_title: "Plot",
  tab: "cycles",
  analysis_modified_at: "analysis-revision-1",
  plot_modified_at: "plot-revision-1",
  expected_data_signature: "source-1",
  ...overrides,
});

test("consecutive warmup generations have distinct analysis query identities", () => {
  const first = warmupAnalysisQueryKey(task());
  const second = warmupAnalysisQueryKey(
    task({
      id: "analysis:plot:generation-2",
      expected_data_signature: "source-2",
      analysis_modified_at: "analysis-revision-2",
    }),
  );
  assert.notDeepEqual(first, second);
});

test("warmup rendering requires both analysis and saved-plot revisions", () => {
  const current = task();
  assert.equal(
    warmupAnalysisRevisionsMatch(
      current,
      { modified_at: current.analysis_modified_at! },
      current.plot_modified_at,
    ),
    true,
  );
  assert.equal(
    warmupAnalysisRevisionsMatch(
      current,
      { modified_at: "new-analysis-revision" },
      current.plot_modified_at,
    ),
    false,
  );
  assert.equal(
    warmupAnalysisRevisionsMatch(
      current,
      { modified_at: current.analysis_modified_at! },
      "new-plot-revision",
    ),
    false,
  );
});
