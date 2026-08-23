import type {
  TimeCapacityRefinementResult,
  TimeCapacityResult,
} from "../../../../../api";
import {
  timeCapacityRefinementRequestIsCurrent,
  type TimeCapacityViewport,
} from "./timeCapacityRefinementPolicy.ts";

export type TimeCapacityRefinementDisplay = {
  result: TimeCapacityRefinementResult;
  viewport: TimeCapacityViewport;
  compatibilitySignature: string;
};

/**
 * Own the ephemeral request/display boundary used by the Time/Capacity card.
 * React and Plotly remain responsible for rendering and side effects; this
 * controller makes generation, stacked invalidation, and response acceptance
 * one testable lifecycle instead of duplicating those decisions in callbacks.
 */
export class TimeCapacityRefinementLifecycle {
  private generationValue = 0;
  private requestedViewportValue: TimeCapacityViewport | null = null;
  private displayedValue: TimeCapacityRefinementDisplay | null = null;
  private stackedValue: boolean;

  constructor(stacked = false) {
    this.stackedValue = stacked;
  }

  get generation(): string {
    return String(this.generationValue);
  }

  get requestedViewport(): TimeCapacityViewport | null {
    return this.requestedViewportValue;
  }

  get displayed(): TimeCapacityRefinementDisplay | null {
    return this.displayedValue;
  }

  setStacked(stacked: boolean): void {
    this.stackedValue = stacked;
  }

  cancelPending(): void {
    this.generationValue += 1;
    this.requestedViewportValue = null;
  }

  clearDisplayed(): void {
    this.displayedValue = null;
  }

  invalidate(): void {
    this.cancelPending();
    this.clearDisplayed();
  }

  beginRequest(viewport: TimeCapacityViewport): string {
    this.requestedViewportValue = { ...viewport };
    return this.generation;
  }

  acceptResponse(
    response: TimeCapacityRefinementResult,
    currentResult: TimeCapacityResult | undefined,
    generation: string,
    viewport: TimeCapacityViewport,
    compatibilitySignature: string,
  ): boolean {
    if (
      this.stackedValue ||
      generation !== this.generation ||
      !timeCapacityRefinementRequestIsCurrent(response, currentResult, generation)
    ) {
      return false;
    }
    this.displayedValue = {
      result: response,
      viewport: { ...viewport },
      compatibilitySignature,
    };
    return true;
  }
}
