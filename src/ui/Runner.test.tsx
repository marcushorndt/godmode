/**
 * The runner's durability, driven through the real component.
 *
 * The defect this is pinned against was not subtle and was not hypothetical: the session lived
 * in React state and refs until the workout was saved, so a killed tab took the reps with it.
 * A pure-function test cannot show that it is fixed, because the thing that was broken was the
 * wiring. So this renders the component, taps its buttons, throws away everything that is not
 * on "disk", renders it again, and checks the reps came back.
 *
 * React's own `act` and `react-dom/client` do the work — no test-renderer dependency is added
 * for six tests.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanSlotRecord, WorkoutDraftRecord } from '../db/schema.js';
import type { WorkoutPerformance } from '../core/types.js';
import { Runner } from './Runner.js';
import { newDraft } from './draft.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const T0 = Date.parse('2026-07-30T09:00:00.000Z');

const slot: PlanSlotRecord = {
  id: 'slot_1',
  challengeId: 'ch_1',
  ordinal: 1,
  week: 1,
  day: 1,
  patternId: 'percentage-ramp',
  patternVersion: 1,
  generatedAt: new Date(T0).toISOString(),
  targets: [
    { index: 1, targetKind: 'reps', reps: 10, role: 'medium', isAmrap: false, restAfterSeconds: 30 },
    { index: 2, targetKind: 'reps', reps: 12, role: 'big', isAmrap: false, restAfterSeconds: 30 },
    { index: 3, targetKind: 'reps', reps: 8, role: 'amrap', isAmrap: true },
  ],
  targetTotal: 30,
  restSeconds: 30,
  status: 'available',
};

function freshDraft(): WorkoutDraftRecord {
  return newDraft({
    id: 'wo_1',
    challengeId: 'ch_1',
    chainId: 'ch_1',
    slot,
    attemptNo: 1,
    effectiveTargets: [10, 12, 8],
    adjustmentType: 'none',
    nowMs: T0,
  });
}

let container: HTMLDivElement;
let root: Root;
/** Everything the app was asked to write, in order. Stands in for IndexedDB. */
let written: WorkoutDraftRecord[];
let finished: { performance: WorkoutPerformance; durationSeconds: number }[];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  written = [];
  finished = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(draft: WorkoutDraftRecord): void {
  act(() => {
    root.render(
      <Runner
        draft={draft}
        slot={slot}
        exerciseLabel="Liegestütze"
        onPersist={(next) => written.push(structuredClone(next))}
        onFinish={(performance, durationSeconds) => finished.push({ performance, durationSeconds })}
        onCancel={() => undefined}
      />,
    );
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`no button labelled "${label}" — have: ${buttonLabels().join(' | ')}`);
  return found;
}

function buttonLabels(): string[] {
  return [...container.querySelectorAll('button')].map(
    (b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '',
  );
}

function click(label: string): void {
  act(() => {
    button(label).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function text(): string {
  return container.textContent ?? '';
}

const last = (): WorkoutDraftRecord => {
  const record = written.at(-1);
  if (!record) throw new Error('nothing was written');
  return record;
};

describe('the screen says what is being trained', () => {
  it('names the exercise in a heading, through every phase of the session', () => {
    render(freshDraft());
    const heading = (): string => container.querySelector('h1')?.textContent ?? '';

    expect(heading()).toBe('Liegestütze');
    click('Set done');
    expect(heading()).toBe('Liegestütze'); // resting
    click('Skip rest');
    expect(heading()).toBe('Liegestütze'); // set 2
  });
});

describe('a completed set is durable immediately', () => {
  it('writes the stamp and the next phase before anything else happens', () => {
    render(freshDraft());
    expect(written).toHaveLength(0);

    click('Set done');

    expect(written).toHaveLength(1);
    expect(last().stamps[0]).not.toBeNull();
    expect(last().stamps[1]).toBeNull();
    expect(last().index).toBe(1);
    expect(last().phase).toBe('rest');
    expect(last().restEndsAt).toBe(new Date(T0 + 30_000).toISOString());
  });

  it('records the reps that were actually entered, not the prescription', () => {
    render(freshDraft());
    click('One more rep');
    click('One more rep');
    click('Set done');

    expect(last().actuals[0]).toBe(12);
  });
});

describe('the tab dies mid-workout', () => {
  it('comes back on the set it was on, with the reps already done', () => {
    render(freshDraft());
    click('One more rep');
    click('Set done'); // set 1: 11 reps
    click('Skip rest');
    click('One less rep');
    click('Set done'); // set 2: 11 reps

    const onDisk = last();

    // The crash: everything in memory goes away and the component is built again from the
    // only thing that survived.
    act(() => root.unmount());
    root = createRoot(container);
    written = [];
    render(onDisk);

    // Back exactly where it was: resting before set 3, with 11 + 11 already banked. Which set
    // is next is asserted by skipping into it rather than by a "Next: 8+" line, which the rest
    // screen no longer carries — the set row above the clock already highlights it.
    expect(text()).toContain('running 22');

    click('Skip rest');
    expect(text()).toContain('Set 3 of 3');
  });

  it('resumes a rest that has already expired straight into the set', () => {
    render(freshDraft());
    click('Set done');
    const onDisk = last();
    expect(onDisk.phase).toBe('rest');

    act(() => root.unmount());
    root = createRoot(container);
    written = [];

    // Ten minutes later. The rest is long over.
    vi.setSystemTime(T0 + 600_000);
    render(onDisk);

    expect(text()).toContain('Set 2 of 3');
    expect(last().phase).toBe('set');
  });

  it('resumes a rest that is still running with the time that is genuinely left', () => {
    render(freshDraft());
    click('Set done');
    const onDisk = last();

    act(() => root.unmount());
    root = createRoot(container);
    written = [];

    vi.setSystemTime(T0 + 10_000);
    render(onDisk);

    // 30s of rest, 10s gone.
    expect(text()).toContain('0:20');
  });
});

describe('rep edits are debounced, but never dropped', () => {
  it('waits for the tapping to stop and then writes once', () => {
    render(freshDraft());

    click('One more rep');
    click('One more rep');
    click('One more rep');
    expect(written).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(written).toHaveLength(1);
    expect(last().actuals[0]).toBe(13);
  });

  it('flushes what is pending when the app is backgrounded', () => {
    render(freshDraft());
    click('One more rep');
    expect(written).toHaveLength(0);

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(written).toHaveLength(1);
    expect(last().actuals[0]).toBe(11);
  });

  it('flushes what is pending when the runner is left', () => {
    render(freshDraft());
    click('One more rep');

    act(() => root.unmount());
    root = createRoot(container);

    expect(written).toHaveLength(1);
    expect(last().actuals[0]).toBe(11);
  });
});

describe('saving', () => {
  function runToReview(): void {
    render(freshDraft());
    click('Set done');
    click('Skip rest');
    click('Set done');
    click('Skip rest');
    click('Finish workout');
  }

  it('hands over every set with its stamps and the adjustment it was started with', () => {
    runToReview();
    expect(text()).toContain('Check your numbers');

    click('Save workout');

    expect(finished).toHaveLength(1);
    const { performance } = finished[0]!;
    expect(performance.actualTotal).toBe(30);
    expect(performance.effectiveTotal).toBe(30);
    expect(performance.adjustmentType).toBe('none');
    expect(performance.sets).toHaveLength(3);
    expect(performance.sets.every((s) => s.startedAt !== undefined)).toBe(true);
  });

  it('writes nothing more once the workout has been handed over', () => {
    runToReview();
    // An edit on the review screen, still inside its debounce window when Save is pressed.
    click('One more on set 1');
    click('Save workout');

    const beforeCount = written.length;
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // A late write would put the draft back after `logWorkout` deleted it, and the app would
    // offer to redo a session that is already in the history.
    expect(written).toHaveLength(beforeCount);
  });

  it('writes a review correction before it hands the workout over', () => {
    runToReview();
    written = [];
    // Corrected and saved inside the 400ms debounce window. If the save then failed and the
    // tab died, the draft on disk has to carry the correction the user was told was safe.
    click('One more on set 1');
    click('Save workout');

    expect(written).toHaveLength(1);
    expect(last().actuals[0]).toBe(11);
    expect(finished[0]!.performance.sets[0]!.actual).toBe(11);
  });

  it('does not write the draft again when the runner unmounts after saving', () => {
    runToReview();
    click('Save workout');
    const beforeCount = written.length;

    act(() => root.unmount());
    root = createRoot(container);

    expect(written).toHaveLength(beforeCount);
  });

  it('cannot be pressed twice', () => {
    runToReview();
    click('Save workout');
    expect(button('Saving…').disabled).toBe(true);
    expect(finished).toHaveLength(1);
  });
});
