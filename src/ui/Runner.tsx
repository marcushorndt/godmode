/**
 * The workout runner.
 *
 * The AMRAP set is the focal input (RUN-05) — the other sets are essentially a countdown,
 * but the open-ended one is where progress is actually decided. Presentation is driven by
 * target metadata, so zero, one, or several AMRAP sets all render sensibly.
 *
 * Per-set start/end timestamps are recorded (RUN-06), which the incumbent never did — it
 * stored one aggregate duration, which is exactly why its rest behaviour had to be guessed.
 *
 * Everything the session knows is written to IndexedDB as it happens. It used to live in React
 * state and refs until the workout was saved, which meant a killed tab, a crashed browser, an
 * iOS reclaim of the PWA or a service-worker activation threw away every rep already done. The
 * component now runs off a draft record: it is handed one, it edits it, and it hands each
 * version back through `onPersist`. What the user was prescribed — targets, AMRAP flags, rest —
 * is read from that record and never re-read from the slot, so nothing can change underneath a
 * session that is already under way.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatClock } from '../core/stats.js';
import type { PerformedSet, WorkoutPerformance } from '../core/types.js';
import type {
  DraftSetStamp,
  PlanSlotRecord,
  RunnerPhase,
  WorkoutDraftRecord,
} from '../db/schema.js';
import { cueForSecondsLeft, playCue } from './cues.js';
import { restLeftSeconds } from './draft.js';
import { Banner, Button, Card, SetRow } from './kit.js';

/** Seconds remaining at which the clock starts warning, then counting. */
const WARN_AT = 10;
const COUNT_FROM = 5;

/**
 * How long a rep edit sits before it is written.
 *
 * Holding the `+` on an AMRAP set produces a tap every few tens of milliseconds and each one
 * would otherwise be a transaction. A completed set is never debounced — see `completeSet`.
 */
const REP_DEBOUNCE_MS = 400;

/** The part of a draft the runner actually changes. The rest is the frozen prescription. */
interface SessionState {
  actuals: number[];
  stamps: (DraftSetStamp | null)[];
  index: number;
  phase: RunnerPhase;
  restTotalSeconds: number;
  restEndsAt: string | null;
  setStartedAt: string;
}

export interface RunnerProps {
  /**
   * The session, fresh or recovered. Its snapshot fields are captured on mount and never read
   * again, so a re-render with a rebuilt object cannot rewrite a workout in progress.
   */
  draft: WorkoutDraftRecord;
  /** Display context only — the week/day heading. Nothing prescriptive is taken from here. */
  slot: PlanSlotRecord;
  /**
   * The exercise being performed, named at the top of the screen in the largest type on it.
   *
   * Redundant today — one session is one exercise, and the workout row already named it before
   * the runner opened. It is here for the screen this becomes: once a session can hold more than
   * one exercise, "what am I actually doing right now" stops being answerable from the numbers
   * alone, and the answer belongs in the same place it will belong then.
   */
  exerciseLabel: string;
  /** Set when writing the draft has been failing, so the runner can stop promising durability. */
  persistFailed?: boolean;
  /** The last save threw. Brings the save button back rather than stranding a finished workout. */
  saveFailed?: boolean;
  onPersist: (draft: WorkoutDraftRecord) => void;
  onFinish: (performance: WorkoutPerformance, durationSeconds: number) => void;
  onCancel: () => void;
}

export function Runner({
  draft,
  slot,
  exerciseLabel,
  persistFailed = false,
  saveFailed = false,
  onPersist,
  onFinish,
  onCancel,
}: RunnerProps) {
  // The prescription, frozen at mount. `draft` is a prop, and a prop can be replaced; the
  // numbers this session is judged against cannot.
  const base = useRef(draft).current;
  const effectiveTargets = base.effectiveTargets;
  const amrapFlags = base.amrapFlags;
  const setCount = effectiveTargets.length;

  const [session, setSession] = useState<SessionState>(() => ({
    actuals: [...draft.actuals],
    stamps: [...draft.stamps],
    index: draft.index,
    phase: draft.phase,
    restTotalSeconds: draft.restTotalSeconds,
    restEndsAt: draft.restEndsAt,
    setStartedAt: draft.setStartedAt,
  }));
  // A rest that expired while the app was gone comes back at zero and drops straight into the
  // set, because that is what happened.
  const [restLeft, setRestLeft] = useState(() => restLeftSeconds(draft, Date.now()));
  const [saving, setSaving] = useState(false);

  const sessionRef = useRef(session);
  const onPersistRef = useRef(onPersist);
  useEffect(() => {
    onPersistRef.current = onPersist;
  }, [onPersist]);

  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<WorkoutDraftRecord | null>(null);
  // Once the workout is saved the draft is deleted inside the same transaction. A debounced
  // write landing after that would put it straight back, and the app would offer to redo a
  // session already in the history.
  const finishedRef = useRef(false);

  const compose = useCallback(
    (next: SessionState): WorkoutDraftRecord => ({
      ...base,
      ...next,
      updatedAt: new Date().toISOString(),
    }),
    [base],
  );

  const cancelPending = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
  }, []);

  /**
   * Advance the session and write it.
   *
   * `immediate` is the default for everything that represents work done or a decision taken.
   * Only rep edits wait, and only for as long as it takes the user to stop tapping.
   */
  const apply = useCallback(
    (patch: Partial<SessionState>, { immediate = true }: { immediate?: boolean } = {}) => {
      const next = { ...sessionRef.current, ...patch };
      sessionRef.current = next;
      setSession(next);

      if (finishedRef.current) return;
      const record = compose(next);
      cancelPending();
      if (immediate) {
        onPersistRef.current(record);
        return;
      }
      pendingRef.current = record;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const queued = pendingRef.current;
        pendingRef.current = null;
        if (queued && !finishedRef.current) onPersistRef.current(queued);
      }, REP_DEBOUNCE_MS);
    },
    [compose, cancelPending],
  );

  // A save that threw wrote nothing and deleted nothing: the draft is still on the device and
  // the session is still on screen. Re-arm, so the user can press the button again instead of
  // staring at a greyed-out one holding the only copy of their workout.
  useEffect(() => {
    if (!saveFailed) return;
    finishedRef.current = false;
    setSaving(false);
  }, [saveFailed]);

  /** Write anything the debounce is still holding. */
  const flush = useCallback(() => {
    const queued = pendingRef.current;
    cancelPending();
    if (queued && !finishedRef.current) onPersistRef.current(queued);
  }, [cancelPending]);

  // The tab going away is exactly the case this whole file exists for, and it is the one moment
  // a 400ms debounce is too long. `pagehide` fires on an iOS home-screen app being backgrounded,
  // where `beforeunload` does not.
  useEffect(() => {
    const onHide = () => flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      // Leaving the runner without saving — Cancel, or a re-render that unmounts it — still
      // keeps the reps. Unless the workout was saved, in which case the draft is already gone.
      flush();
    };
  }, [flush]);

  const isAmrap = amrapFlags[session.index] === true;
  const target = effectiveTargets[session.index] ?? 0;

  // Rest countdown. A self-rescheduling timeout keyed on the remaining seconds, rather than
  // one long-lived interval, so ±15s takes effect on the very next tick and the value that
  // drives the cues is always the value on screen.
  //
  // The countdown itself is never persisted: the draft stores the instant rest ends, so a
  // ticking clock would be a write a second for no information the deadline does not already
  // carry.
  useEffect(() => {
    if (session.phase !== 'rest') return;
    if (restLeft <= 0) {
      apply({ phase: 'set', setStartedAt: new Date().toISOString(), restEndsAt: null });
      return;
    }
    const timer = window.setTimeout(() => setRestLeft((left) => left - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [session.phase, restLeft, apply]);

  // Cues follow the displayed second. Sounding them here rather than inside the countdown's
  // state updater keeps the updater pure, so React re-invoking it never double-beeps.
  const lastCuedAt = useRef<number | null>(null);
  useEffect(() => {
    if (session.phase !== 'rest') {
      lastCuedAt.current = null;
      return;
    }
    if (lastCuedAt.current === restLeft) return;
    lastCuedAt.current = restLeft;
    const cue = cueForSecondsLeft(restLeft);
    if (cue) playCue(cue);
  }, [session.phase, restLeft]);

  const setActual = useCallback(
    (value: number) => {
      const actuals = [...sessionRef.current.actuals];
      actuals[sessionRef.current.index] = Math.max(0, value);
      apply({ actuals }, { immediate: false });
    },
    [apply],
  );

  const completeSet = useCallback(() => {
    const now = Date.now();
    const current = sessionRef.current;
    const stamps = [...current.stamps];
    stamps[current.index] = {
      startedAt: current.setStartedAt,
      endedAt: new Date(now).toISOString(),
    };

    // A finished set is durable before anything else happens. This is the write the whole
    // mechanism exists for.
    if (current.index + 1 >= setCount) {
      apply({ stamps, phase: 'review' });
      return;
    }

    const rest = base.restSecondsPerSet[current.index] ?? 0;
    setRestLeft(rest);
    apply({
      stamps,
      index: current.index + 1,
      phase: rest > 0 ? 'rest' : 'set',
      restTotalSeconds: rest,
      restEndsAt: rest > 0 ? new Date(now + rest * 1000).toISOString() : null,
      setStartedAt: new Date(now).toISOString(),
    });
  }, [apply, base.restSecondsPerSet, setCount]);

  const adjustRest = useCallback(
    (delta: number) => {
      const current = sessionRef.current;
      const left = Math.max(0, restLeft + delta);
      setRestLeft(left);
      apply({
        restTotalSeconds: Math.max(1, current.restTotalSeconds + delta),
        restEndsAt: new Date(Date.now() + left * 1000).toISOString(),
      });
    },
    [apply, restLeft],
  );

  const skipRest = useCallback(() => {
    setRestLeft(0);
    apply({ phase: 'set', restEndsAt: null, setStartedAt: new Date().toISOString() });
  }, [apply]);

  const editActual = useCallback(
    (i: number, value: number) => {
      const actuals = [...sessionRef.current.actuals];
      actuals[i] = Math.max(0, value);
      apply({ actuals }, { immediate: false });
    },
    [apply],
  );

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    const current = sessionRef.current;
    const sets: PerformedSet[] = current.actuals.map((actual, i) => {
      const stamp = current.stamps[i];
      return {
        index: i + 1,
        effectiveTarget: effectiveTargets[i] ?? 0,
        actual,
        ...(stamp === null || stamp === undefined
          ? {}
          : { startedAt: stamp.startedAt, endedAt: stamp.endedAt }),
      };
    });
    const actualTotal = current.actuals.reduce((s, n) => s + n, 0);
    const effectiveTotal = effectiveTargets.reduce((s, n) => s + n, 0);

    // Write whatever the debounce is still holding BEFORE sealing. A correction made on the
    // review screen and saved within 400ms would otherwise be in the workout being handed over
    // but not in the draft — and if the save then failed and the tab died, the draft offered on
    // the next launch would be missing an edit the user had made and been told was safe.
    flush();

    // From here the draft must not be written again: the save deletes it.
    finishedRef.current = true;
    cancelPending();
    setSaving(true);

    onFinish(
      { sets, actualTotal, adjustmentType: base.adjustmentType, effectiveTotal },
      Math.max(0, Math.round((Date.now() - Date.parse(base.startedAt)) / 1000)),
    );
  }, [effectiveTargets, base.adjustmentType, base.startedAt, cancelPending, flush, onFinish]);

  const runningTotal = useMemo(
    () =>
      session.actuals
        .slice(0, session.phase === 'review' ? setCount : session.index)
        .reduce((s, n) => s + n, 0),
    [session.actuals, session.phase, session.index, setCount],
  );

  return (
    <div className="mx-auto flex min-h-screen w-full flex-col px-4 md:max-w-lg safe-t safe-b">
      {/*
        The exercise named first and largest, above the targets and above the clock. See the prop's
        note: today it repeats what the workout row said, and it is placed here for the version
        of this screen that runs a session made of more than one movement.
      */}
      <header className="flex items-start justify-between gap-3 pb-3">
        <div className="min-w-0">
          <h1 className="truncate text-3xl font-bold tracking-tight text-slate-100 sm:text-4xl">
            {exerciseLabel}
          </h1>
          <div className="truncate text-sm text-slate-400">
            {slot.week !== undefined && slot.day !== undefined
              ? `Week ${slot.week} · Day ${slot.day}`
              : (slot.cycleLabel ?? `Session ${slot.ordinal}`)}
            {base.attemptNo > 1 ? ` · attempt ${base.attemptNo}` : ''}
          </div>
          <div className="tnum text-xs text-slate-500">
            target {base.targetTotal} · running {runningTotal}
          </div>
        </div>
        <Button variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
      </header>

      {/*
        Said plainly rather than swallowed. If the draft cannot be written, this session is back
        to living in memory, and the user is the only one who can decide what to do about it.
      */}
      {persistFailed ? (
        <div className="pb-3">
          <Banner tone="warn">
            This device is not saving your progress right now. Finish and save the workout
            without closing the app.
          </Banner>
        </div>
      ) : null}

      <SetRow
        reps={effectiveTargets}
        amrapFlags={amrapFlags}
        activeIndex={session.phase === 'review' ? undefined : session.index}
        className="pb-4"
      />

      {session.phase === 'rest' ? (
        <RestPanel
          left={restLeft}
          total={session.restTotalSeconds}
          onAdjust={adjustRest}
          onSkip={skipRest}
        />
      ) : null}

      {session.phase === 'set' ? (
        <SetPanel
          setNumber={session.index + 1}
          setCount={setCount}
          target={target}
          isAmrap={isAmrap}
          actual={session.actuals[session.index] ?? 0}
          onChange={setActual}
          onDone={completeSet}
        />
      ) : null}

      {session.phase === 'review' ? (
        <ReviewPanel
          effectiveTargets={effectiveTargets}
          amrapFlags={amrapFlags}
          actuals={session.actuals}
          targetTotal={base.targetTotal}
          saving={saving}
          onEdit={editActual}
          onSave={finish}
        />
      ) : null}
    </div>
  );
}

function RestPanel({
  left,
  total,
  onAdjust,
  onSkip,
}: {
  left: number;
  total: number;
  onAdjust: (delta: number) => void;
  onSkip: () => void;
}) {
  const progress = total <= 0 ? 1 : 1 - left / total;
  const counting = left <= COUNT_FROM;
  const warning = left <= WARN_AT;

  return (
    <Card className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
      <div>
        <div
          className={[
            'text-xs uppercase tracking-widest transition-colors',
            counting ? 'text-teal-300' : warning ? 'text-amber-300' : 'text-slate-400',
          ].join(' ')}
        >
          {counting ? 'Get ready' : 'Rest'}
        </div>
        {/* Re-keyed every second while counting so the pulse animation restarts on each tick. */}
        <div
          key={counting ? left : 'steady'}
          className={[
            'tnum mt-1 text-7xl font-light tabular-nums transition-colors',
            counting ? 'cue-pulse text-teal-200' : warning ? 'text-amber-300' : 'text-slate-100',
          ].join(' ')}
          aria-live="off"
        >
          {formatClock(left)}
        </div>
      </div>

      <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-[#1c2740]">
        <div
          className={[
            'h-full rounded-full transition-[width,background-color] duration-1000 ease-linear',
            warning ? 'bg-amber-300' : 'bg-teal-300',
            counting ? '!bg-teal-200' : '',
          ].join(' ')}
          style={{ width: `${Math.min(100, progress * 100)}%` }}
        />
      </div>

      {/*
        No "Next: 41" line. The set row above the clock already shows every target with the one
        coming up highlighted, so this restated a number the athlete was looking at, two inches
        lower and in smaller type.
      */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={() => onAdjust(-15)} ariaLabel="15 seconds less">
          −15s
        </Button>
        <Button onClick={onSkip}>Skip rest</Button>
        <Button variant="ghost" onClick={() => onAdjust(15)} ariaLabel="15 seconds more">
          +15s
        </Button>
      </div>
    </Card>
  );
}

function SetPanel({
  setNumber,
  setCount,
  target,
  isAmrap,
  actual,
  onChange,
  onDone,
}: {
  setNumber: number;
  setCount: number;
  target: number;
  isAmrap: boolean;
  actual: number;
  onChange: (value: number) => void;
  onDone: () => void;
}) {
  return (
    <Card className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
      <div className="text-xs uppercase tracking-widest text-slate-400">
        Set {setNumber} of {setCount}
      </div>

      {isAmrap ? (
        <>
          <div>
            <div className="tnum text-6xl font-light text-teal-300">{target}+</div>
            <div className="mt-2 text-sm text-slate-300">
              At least {target}. Go as far as you can.
            </div>
          </div>
          <Stepper value={actual} onChange={onChange} big />
        </>
      ) : (
        <>
          <div className="tnum text-7xl font-light text-slate-100">{target}</div>
          <Stepper value={actual} onChange={onChange} />
          {actual !== target ? (
            <div className="tnum text-xs text-amber-300">
              recording {actual} instead of {target}
            </div>
          ) : null}
        </>
      )}

      <Button onClick={onDone} className="w-full max-w-xs">
        {setNumber === setCount ? 'Finish workout' : 'Set done'}
      </Button>
    </Card>
  );
}

function Stepper({
  value,
  onChange,
  big = false,
}: {
  value: number;
  onChange: (value: number) => void;
  big?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button variant="ghost" onClick={() => onChange(value - 1)} ariaLabel="One less rep">
        −
      </Button>
      <input
        type="number"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
        className={`tnum w-24 rounded-xl border border-[#33405c] bg-[#0f1728] px-3 py-2 text-center text-slate-100 outline-none focus:border-teal-400 ${
          big ? 'text-3xl' : 'text-2xl'
        }`}
        aria-label="Reps performed"
      />
      <Button variant="ghost" onClick={() => onChange(value + 1)} ariaLabel="One more rep">
        +
      </Button>
    </div>
  );
}

function ReviewPanel({
  effectiveTargets,
  amrapFlags,
  actuals,
  targetTotal,
  saving,
  onEdit,
  onSave,
}: {
  effectiveTargets: number[];
  amrapFlags: boolean[];
  actuals: number[];
  targetTotal: number;
  saving: boolean;
  onEdit: (index: number, value: number) => void;
  onSave: () => void;
}) {
  const total = actuals.reduce((s, n) => s + n, 0);
  const shortfall = targetTotal - total;

  return (
    <Card className="flex flex-1 flex-col gap-4">
      <div>
        <div className="text-xs uppercase tracking-widest text-slate-400">Check your numbers</div>
        <div className="tnum mt-1 text-4xl font-light text-slate-100">
          {total}
          <span className="ml-2 text-lg text-slate-400">/ {targetTotal}</span>
        </div>
        {shortfall > 0 ? (
          <div className="tnum mt-1 text-sm text-amber-300">
            {shortfall} short. This day comes round again.
          </div>
        ) : (
          <div className="mt-1 text-sm text-teal-300">Target met.</div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {actuals.map((actual, i) => (
          <div key={i} className="flex items-center justify-between gap-3">
            <span className="tnum text-sm text-slate-400">
              Set {i + 1} · target {effectiveTargets[i]}
              {amrapFlags[i] ? '+' : ''}
            </span>
            <span className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => onEdit(i, actual - 1)} ariaLabel={`One less on set ${i + 1}`}>
                −
              </Button>
              <input
                type="number"
                inputMode="numeric"
                value={actual}
                onChange={(e) => onEdit(i, e.target.value === '' ? 0 : Number(e.target.value))}
                className="tnum w-20 rounded-lg border border-[#33405c] bg-[#0f1728] px-2 py-1.5 text-center text-slate-100 outline-none focus:border-teal-400"
                aria-label={`Reps on set ${i + 1}`}
              />
              <Button variant="ghost" onClick={() => onEdit(i, actual + 1)} ariaLabel={`One more on set ${i + 1}`}>
                +
              </Button>
            </span>
          </div>
        ))}
      </div>

      <Banner tone="info">Correct anything you mis-tapped before saving.</Banner>

      {/* Disabled the moment it is pressed: the save is a transaction, and a second press
          while it is in flight is one the user did not mean to make. */}
      <Button onClick={onSave} className="w-full" disabled={saving}>
        {saving ? 'Saving…' : 'Save workout'}
      </Button>
    </Card>
  );
}
