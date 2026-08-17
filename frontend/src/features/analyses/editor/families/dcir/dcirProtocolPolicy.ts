import type {
  DcirSegmentTarget,
  FileProtocol,
  ProtocolFamilyGroup,
  ProtocolSegment,
} from "../../../../../api";
import { isEmptyRestPauseStep } from "../../protocol/protocolComparability.ts";

export interface DcirProtocolFamilyLike {
  signature: string;
  protocol: FileProtocol;
}

export interface DcirTargetValidationOptions {
  ignoreEmptyRestPause?: boolean;
}

/**
 * Validate and materialize a rest/pulse target in executable workflow order.
 * Empty Rest/Pause rows may be omitted only when the saved grouping that owns
 * the whole target explicitly authorized that policy.
 */
export function dcirTargetFromSteps(
  family: DcirProtocolFamilyLike,
  stepIndices: number[],
  options: DcirTargetValidationOptions = {},
): DcirSegmentTarget | null {
  if (stepIndices.length !== 2) return null;
  const [restStep, pulseStep] = [...stepIndices].sort((a, b) => a - b);
  const rest = family.protocol.steps.find((step) => step.number === restStep);
  const pulse = family.protocol.steps.find((step) => step.number === pulseStep);
  if (!rest || !pulse || rest.direction !== "rest") return null;
  if (options.ignoreEmptyRestPause && isEmptyRestPauseStep(rest)) return null;
  if (pulse.direction !== "charge" && pulse.direction !== "discharge") return null;
  const executable = family.protocol.steps.filter(
    (step) =>
      step.direction !== "control" &&
      !(options.ignoreEmptyRestPause && isEmptyRestPauseStep(step)),
  );
  const restPosition = executable.findIndex((step) => step.number === rest.number);
  if (restPosition < 0 || executable[restPosition + 1]?.number !== pulse.number) {
    return null;
  }
  return {
    protocol_signature: family.signature,
    rest_step_index: rest.number,
    pulse_step_index: pulse.number,
    direction: pulse.direction,
    current_ma: pulse.current_ma,
    c_rate: pulse.c_rate,
    rest_duration_s: rest.time_limit_s,
    pulse_duration_s: pulse.time_limit_s,
  };
}

function canonicalFamilySignature(
  families: DcirProtocolFamilyLike[],
  signature: string,
): string | null {
  const family = families.find(
    (item) =>
      item.signature === signature ||
      (item.protocol.legacy_signatures ?? []).includes(signature),
  );
  return family?.signature ?? null;
}

/**
 * Resolve the no-op policy from an exact saved group membership. If multiple
 * definitions share membership with conflicting policies, fail closed: a
 * segment does not carry enough provenance to safely choose one.
 */
export function dcirIgnoreEmptyRestPauseForSegment(
  segment: ProtocolSegment,
  families: DcirProtocolFamilyLike[],
  groups: ProtocolFamilyGroup[],
): boolean {
  const targetSignatures = new Set(
    segment.targets
      .map((target) => canonicalFamilySignature(families, target.protocol_signature))
      .filter((signature): signature is string => signature !== null),
  );
  if (targetSignatures.size === 0 || targetSignatures.size !== segment.targets.length) {
    return false;
  }

  const policies = new Set<boolean>();
  for (const group of groups) {
    if (!group.comparison_dimensions.structure) continue;
    const groupSignatures = group.family_signatures.map((signature) =>
      canonicalFamilySignature(families, signature),
    );
    if (groupSignatures.some((signature) => signature === null)) continue;
    const membership = new Set(groupSignatures as string[]);
    if (
      membership.size === targetSignatures.size &&
      [...membership].every((signature) => targetSignatures.has(signature))
    ) {
      policies.add(Boolean(group.ignore_empty_rest_pause));
    }
  }
  return policies.size === 1 ? [...policies][0] : false;
}
