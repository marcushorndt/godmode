/**
 * The current session, plus adjustment and the continuation flow.
 *
 * Adjustment distinguishes redistribute (total unchanged, never affects pass/fail) from
 * rescale (total changes). Scaling down is honest work that does not advance the plan, and
 * the copy says so plainly rather than calling it a failure.
 */

import { useMemo, useState } from 'react';
import { formatClock } from '../core/stats.js';
import type { AdjustmentType } from '../core/types.js';
import type { ChallengeRecord, PlanSlotRecord } from '../db/schema.js';
import { Banner, Button, Card, NumberField, SetRow, Stat } from './kit.js';

/** One session an extension would add, as the confirmation shows it. */
export interface ExtensionSession {
  week: number | undefined;
  day: number | undefined;
  ordinal: number;
  targetTotal: number;
}

export interface TodayProps {
  challenge: ChallengeRecord;
  slot: PlanSlotRecord | undefined;
  attemptNo: number;
  exerciseLabel: string;
  slotsAdvanced: number;
  slotsTotal: number;
  lastMessage: string | null;
  /**
   * The sessions "Add another week" would append, already computed.
   *
   * Undefined when this plan cannot be extended — a pattern that does not support it, or a plan
   * the app cannot account for. The button is then simply not offered.
   */
  extension?: ExtensionSession[] | undefined;
  /** Why another week cannot be offered, when that is a fault worth naming rather than silence. */
  extensionProblem?: string | undefined;
  onStart: (effectiveTargets: number[], adjustment: AdjustmentType) => void;
  onAdvanceManually: () => void;
  onExtend: () => void;
  onContinueChain: () => void;
  onDismissMessage: () => void;
  /** Opens the export sheet. The moment a session lands is when someone wants to post it. */
  onShare?: () => void;
}

export function Today({
  challenge,
  slot,
  attemptNo,
  exerciseLabel,
  slotsAdvanced,
  slotsTotal,
  lastMessage,
  extension,
  extensionProblem,
  onStart,
  onAdvanceManually,
  onExtend,
  onContinueChain,
  onDismissMessage,
  onShare,
}: TodayProps) {
  const [adjusting, setAdjusting] = useState(false);
  const [draft, setDraft] = useState<number[]>([]);

  const baseTargets = useMemo(() => slot?.targets.map((t) => t.reps) ?? [], [slot]);
  const amrapFlags = useMemo(() => slot?.targets.map((t) => t.isAmrap) ?? [], [slot]);

  if (!slot) {
    return (
      <div className="flex flex-col gap-4 lg:max-w-2xl">
        <Card>
          <h2 className="text-xl font-semibold text-slate-100">Every day in this plan is done</h2>

          {/*
            The numbers before the button, deliberately. "Add another week" is a write against a
            plan with months of history behind it, and the honest way to ask for it is to show
            exactly what it will add — three sessions and what each one asks for — rather than a
            paragraph describing them.
          */}
          {extension && extension.length > 0 ? (
            <>
              <ul className="mt-4 flex flex-col gap-1.5">
                {extension.map((session) => (
                  <li
                    key={session.ordinal}
                    className="flex items-baseline justify-between gap-3 rounded-xl bg-[#0f1728] px-3 py-2"
                  >
                    <span className="text-sm text-slate-300">
                      {session.week !== undefined && session.day !== undefined
                        ? `Week ${session.week} · Day ${session.day}`
                        : `Session ${session.ordinal}`}
                    </span>
                    <span className="tnum text-sm font-semibold text-teal-300">
                      {session.targetTotal} reps
                    </span>
                  </li>
                ))}
              </ul>
              <Button className="mt-4 w-full" onClick={onExtend}>
                Add another week
              </Button>
            </>
          ) : null}

          {extensionProblem !== undefined ? (
            <p className="mt-4 text-sm leading-relaxed text-amber-300">
              Another week cannot be added: {extensionProblem}
            </p>
          ) : null}

          <Button variant="ghost" className="mt-2 w-full" onClick={onContinueChain}>
            Continue with a new block
          </Button>
          <p className="mt-2 text-xs leading-relaxed text-slate-400">
            A new block retests your max and starts again from week 1.
          </p>
        </Card>
      </div>
    );
  }

  const draftTotal = draft.reduce((s, n) => s + n, 0);
  const baseTotal = slot.targetTotal;
  const adjustment: AdjustmentType =
    !adjusting || draftTotal === baseTotal
      ? draft.length > 0 && draft.some((n, i) => n !== baseTargets[i])
        ? 'redistributed'
        : 'none'
      : draftTotal > baseTotal
        ? 'scaled_up'
        : 'scaled_down';

  const effectiveTargets = adjusting && draft.length > 0 ? draft : baseTargets;

  return (
    // Mobile stacks in the original order. From lg the session and its adjust panel take
    // the wide column and the context — plan numbers, the stuck-on-this-day escape — moves
    // into a rail, so nothing that matters mid-session sits below the fold on a laptop.
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start">
      {lastMessage ? (
        <div className="lg:col-span-2">
          <Banner tone="good" onDismiss={onDismissMessage}>
            {lastMessage}
            {onShare ? (
              <>
                {' '}
                <button type="button" className="underline" onClick={onShare}>
                  Share your progress
                </button>
                .
              </>
            ) : null}
          </Banner>
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm text-slate-400">{exerciseLabel}</div>
              <h2 className="text-2xl font-semibold text-slate-100">
                {slot.week !== undefined && slot.day !== undefined
                  ? `Week ${slot.week} · Day ${slot.day}`
                  : (slot.cycleLabel ?? `Session ${slot.ordinal}`)}
              </h2>
              {attemptNo > 1 ? (
                <div className="mt-0.5 text-sm text-amber-300">Attempt {attemptNo}</div>
              ) : null}
            </div>
            <div className="shrink-0 text-right">
              <div className="tnum text-2xl font-semibold text-teal-300">{slot.targetTotal}</div>
              <div className="text-xs text-slate-400">reps to pass</div>
            </div>
          </div>

          <SetRow reps={effectiveTargets} amrapFlags={amrapFlags} className="mt-4" />

          <div className="mt-4 flex items-center gap-4 text-xs text-slate-400">
            <span className="tnum">rest {formatClock(slot.restSeconds)}</span>
            <span className="tnum">
              day {slotsAdvanced + 1} of {slotsTotal}
            </span>
          </div>

          {adjustment !== 'none' ? (
            <div className="mt-3 text-xs">
              {adjustment === 'scaled_down' ? (
                <span className="text-amber-300">
                  Scaled down to {draftTotal}. This day stays next until you reach {baseTotal}.
                </span>
              ) : adjustment === 'scaled_up' ? (
                <span className="text-teal-300">Scaled up to {draftTotal}.</span>
              ) : (
                <span className="text-slate-300">Same {baseTotal} reps, different shape.</span>
              )}
            </div>
          ) : null}

          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <Button className="flex-1" onClick={() => onStart(effectiveTargets, adjustment)}>
              Start
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setAdjusting((v) => !v);
                setDraft(adjusting ? [] : [...baseTargets]);
              }}
            >
              {adjusting ? 'Reset' : 'Adjust'}
            </Button>
          </div>
        </Card>

        {adjusting ? (
          <Card>
            <h3 className="font-semibold text-slate-100">Adjust the sets</h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Move reps between sets, or change the total for an easier or harder day.
            </p>
            <div className="mt-4 flex flex-col gap-3">
              {draft.map((value, i) => (
                <NumberField
                  key={i}
                  label={`Set ${i + 1}${amrapFlags[i] ? ' (open-ended)' : ''}`}
                  value={value}
                  min={1}
                  onChange={(next) =>
                    setDraft((prev) => {
                      const copy = [...prev];
                      copy[i] = next === '' ? 1 : Math.max(1, next);
                      return copy;
                    })
                  }
                  suffix="reps"
                />
              ))}
            </div>
            <div className="tnum mt-4 text-sm text-slate-300">
              Total {draftTotal} · prescribed {baseTotal}
            </div>
          </Card>
        ) : null}
      </div>

      {/* Ordered so that stacking the rail on mobile reproduces the original sequence. */}
      <div className="flex flex-col gap-4">
        {attemptNo >= 3 ? (
          <Card>
            <h3 className="font-semibold text-slate-100">Stuck on this day?</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
              Move on without hitting the number. It's marked as skipped in your history.
            </p>
            <Button variant="ghost" className="mt-4 w-full" onClick={onAdvanceManually}>
              Move to the next day anyway
            </Button>
          </Card>
        ) : null}

        <Card>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Baseline" value={challenge.baseline.value} sub={challenge.baseline.source} />
            <Stat label="Goal" value={challenge.goalValue ?? '—'} sub="plan input" />
            <Stat label="Days done" value={`${slotsAdvanced}/${slotsTotal}`} />
          </div>
        </Card>
      </div>
    </div>
  );
}
