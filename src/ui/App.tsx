/**
 * App shell: signs in, loads one snapshot, routes between screens, and owns the write paths.
 *
 * ## What changed at the cutover
 *
 * `load()` used to make five independent IndexedDB reads and then three more. It is now one
 * `GET /api/snapshot`, and the `revision` it carries goes back out with every ordinary command
 * so a stale client gets a `409` with fresh state instead of overwriting the other device
 * (`.planning/DESIGN-server-sqlite.md` §6, §7).
 *
 * `finishWorkout` used to assume `logWorkout` either succeeded or threw. It cannot assume that
 * any more, and the states it can land in are named rather than collapsed: **saved · queued
 * offline · conflict · unauthorised · server unreachable · draft recovered**. The one rule that
 * outranks all of them: a finished workout is never dropped. If the POST does not succeed for
 * any reason at all, the workout goes into the IndexedDB outbox and the user is told plainly
 * that it is on this device and not yet on the server.
 *
 * More than one exercise can be on the go at once. The shell resolves which challenge is
 * showing (a stored preference with a fall-back), and everything below it is scoped to that
 * one challenge's chain.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AdjustmentType, WorkoutPerformance } from '../core/types.js';
import {
  ApiError,
  closeSession,
  endChallenge as endChallengeCommand,
  extendChallenge as extendChallengeCommand,
  getSnapshot,
  patchSettings,
  postWorkout,
  sessionState,
  startNextBlock as startNextBlockCommand,
  type Snapshot,
} from '../api/client.js';
import { drainOutbox } from '../api/drain.js';
import {
  activeChallenges,
  applyPending,
  attemptsOn,
  currentSlot as pickCurrentSlot,
  exerciseLabels,
  resolveSelectedChallenge,
  slotsFor,
  workoutsForChain,
} from '../api/snapshot.js';
import {
  backupFilename,
  buildBackup,
  buildCsv,
  csvFilename,
  downloadFile,
  shouldPromptBackup,
} from '../data/exchange.js';
import {
  clearDraftsForSlot,
  deleteDraft,
  listDrafts,
  markWorkoutSettled,
  saveDraft,
} from '../db/drafts.js';
import { requestPersistentStorage } from '../db/local.js';
import { enqueueWorkout, listOutbox, OutboxWriteError, unblockAll } from '../db/outbox.js';
import {
  buildExtension,
  buildNextBlock,
  buildWorkout,
  newId,
  PlanExtensionError,
  type PlanExtension,
} from '../db/records.js';
import type {
  ChallengeRecord,
  DatabaseConflict,
  OutboxEntry,
  PlanSlotRecord,
  SettingsRecord,
  WorkoutDraftRecord,
  WorkoutRecord,
} from '../db/schema.js';
import { onDatabaseConflict } from '../db/schema.js';
import { ExportSheet } from './ExportSheet.js';
import { History } from './History.js';
import { Runner } from './Runner.js';
import { LeaveRunnerDialog, ResumeDialog } from './ResumeDialog.js';
import { Settings } from './Settings.js';
import { SignIn } from './SignIn.js';
import { Today } from './Today.js';
import { AddWorkout, ImportHistory, Welcome } from './Welcome.js';
import { chooseDraftOffer, draftProgress, newDraft } from './draft.js';
import { TABS, shouldShowWorkoutBar, type Tab } from './nav.js';
import { buildShareCard, toStatWorkouts } from './shareCardData.js';
import { Banner, Button, Card, NumberField, Segmented, Spinner } from './kit.js';
// The update seam only. Nothing here imports ../pwa/lifecycle.js: that module owns the
// `virtual:pwa-register` import, which does not resolve under Vitest, and pulling it into this
// file's module graph would take every App test down with it.
import { shouldOfferUpdate } from '../pwa/policy.js';
import { applyUpdate, subscribeUpdateReady } from '../pwa/updateStore.js';

type View =
  | { kind: 'tab'; tab: Tab }
  | { kind: 'runner' }
  | { kind: 'continue' }
  | { kind: 'add-workout' }
  | { kind: 'import-history' };

/** Where the app stands with its server. Every one of these says something different. */
type Session =
  | { kind: 'checking' }
  | { kind: 'signed-out'; reason?: string | undefined }
  | { kind: 'signed-in' }
  /** The server is there but speaks a version this build cannot read. Nothing is attempted. */
  | { kind: 'incompatible'; message: string };

const TAB_KEY = 'godmode.tab';

/**
 * Whether the workout row offers "add a workout".
 *
 * Off deliberately, 2026-07-30. Everything behind this flag works — the flow builds a real
 * challenge — but it can only ever build ONE shape of plan: `percentage-ramp`, parameterised by
 * goal, weeks and days per week. The generator names that pattern directly rather than resolving
 * the `patternId` it already stores, and the form's fields are that pattern's parameters, not
 * universal ones. A general-looking "+" therefore promises a generality the app does not have.
 *
 * Turning this back to `true` is the whole change. What should come first is in
 * `.planning/BACKLOG.md` → "Richer workouts and plans": the pattern registry, then a second
 * pattern worth choosing between.
 *
 * While this is false there is NO way to add a second workout in the UI. That is intended and
 * was asked for — do not "fix" it without asking.
 */
const ADD_WORKOUT_ENABLED = false;

/**
 * The open tab survives a reload. localStorage rather than the settings record because it is a
 * UI position, not user data — it should not travel in a backup or overwrite the tab on another
 * device.
 */
function storedTab(): Tab {
  try {
    const raw = window.localStorage.getItem(TAB_KEY);
    return TABS.includes(raw as Tab) ? (raw as Tab) : 'today';
  } catch {
    // Private mode, or storage disabled. Not worth failing over.
    return 'today';
  }
}

/**
 * How often the plan expects you to train, from the challenge's own pattern params.
 *
 * `patternParams` is deliberately an opaque record — a future pattern will not share the
 * percentage ramp's fields — so this reads defensively rather than casting.
 */
function daysPerWeek(challenge: ChallengeRecord): number {
  const raw = challenge.patternParams['daysPerWeek'];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 3;
}

function rememberTab(tab: Tab): void {
  try {
    window.localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Ignored, as above.
  }
}

interface State {
  /** Every active challenge, so the switcher can list them. */
  active: ChallengeRecord[];
  challenge: ChallengeRecord | undefined;
  labels: Map<string, string>;
  slots: PlanSlotRecord[];
  workouts: WorkoutRecord[];
  currentSlot: PlanSlotRecord | undefined;
  attemptNo: number;
  settings: SettingsRecord;
  exerciseLabel: string;
  /** Across every exercise and every ended chain — durability is a whole-dataset property. */
  totalWorkouts: number;
}

export function App() {
  const [session, setSession] = useState<Session>({ kind: 'checking' });
  /** Exactly as the server last described it. Never edited in place. */
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  /** Finished workouts this device is still holding. */
  const [pending, setPending] = useState<OutboxEntry[]>([]);
  /** In-progress workouts found on this device. Normally none, or exactly one. */
  const [drafts, setDrafts] = useState<WorkoutDraftRecord[]>([]);
  const [view, setView] = useState<View>(() => ({ kind: 'tab', tab: storedTab() }));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The last command hit a 409. Its fresh snapshot is already on screen. */
  const [conflicted, setConflicted] = useState(false);
  /** The server did not answer. Reads and writes both surface it here. */
  const [offline, setOffline] = useState(false);
  /** The session the runner is driving. Its `id` is the id the workout will be saved under. */
  const [run, setRun] = useState<WorkoutDraftRecord | null>(null);
  /** A draft the user has been shown and left alone. Offering it again on every render would nag. */
  const [dismissedDraftId, setDismissedDraftId] = useState<string | null>(null);
  const [leavePrompt, setLeavePrompt] = useState(false);
  /** Writing the draft is failing. The runner says so rather than promising a durability it has lost. */
  const [draftBroken, setDraftBroken] = useState(false);
  /** The last save attempt could not be kept anywhere. The runner re-arms its save button on this. */
  const [saveFailed, setSaveFailed] = useState(false);
  const [dbConflict, setDbConflict] = useState<DatabaseConflict | null>(null);
  const [backupDismissed, setBackupDismissed] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);

  /** Whatever this device is still holding, re-read. Cheap, local, and never fails a render. */
  const readLocal = useCallback(async () => {
    const [entries, found] = await Promise.all([listOutbox(), listDrafts()]);
    setPending(entries);
    setDrafts(found);
  }, []);

  /**
   * Turn a failed command into the right screen.
   *
   * Returns true when it recognised the failure, so callers can fall through to a generic
   * message for anything else rather than swallowing it.
   */
  const handleFailure = useCallback((cause: unknown): boolean => {
    if (!(cause instanceof ApiError)) return false;
    switch (cause.kind) {
      case 'unauthorised':
        setSession({
          kind: 'signed-out',
          reason: 'Your session has expired. Sign in again — nothing has been lost.',
        });
        return true;
      case 'version':
        setSession({ kind: 'incompatible', message: cause.message });
        return true;
      case 'conflict':
        // Every 409 carries the current state, so the conflict is shown rather than described.
        if (cause.snapshot) setSnapshot(cause.snapshot);
        setConflicted(true);
        setError(cause.message);
        return true;
      case 'unreachable':
        setOffline(true);
        setError(cause.message);
        return true;
      default:
        setError(cause.message);
        return true;
    }
  }, []);

  /**
   * Send what is queued and fold the result into the screen. Never rejects.
   *
   * Every caller is fire-and-forget — a load, a reconnect, a button — so a rejection here would
   * be an unhandled one, and a drain can reject on something that is not an `ApiError` at all
   * (IndexedDB going away mid-read). Codex found those callers unguarded.
   */
  const syncNow = useCallback(
    async (announce = false): Promise<void> => {
      try {
        const result = await drainOutbox();
        if (result.snapshot) {
          setSnapshot(result.snapshot);
          setOffline(false);
        }
        if (result.stoppedBy) handleFailure(result.stoppedBy);
        else if (announce && result.sent > 0) {
          setMessage(
            `${String(result.sent)} workout${result.sent === 1 ? '' : 's'} saved to the server.`,
          );
        }
      } catch (cause) {
        if (!handleFailure(cause)) {
          setError(
            cause instanceof Error
              ? `Could not send what is waiting: ${cause.message}`
              : 'Could not send what is waiting. Nothing has been lost.',
          );
        }
      }
      await readLocal().catch(() => undefined);
    },
    [handleFailure, readLocal],
  );

  /**
   * One snapshot, then whatever is queued.
   *
   * The drain happens here rather than only on reconnect because a tab that was closed with a
   * queued workout has no reconnect event to wait for.
   */
  const load = useCallback(async () => {
    try {
      const fresh = await getSnapshot();
      setSnapshot(fresh);
      setOffline(false);
      setConflicted(false);
      setSession({ kind: 'signed-in' });

      await syncNow();
    } catch (cause) {
      if (!handleFailure(cause)) {
        setError(cause instanceof Error ? cause.message : 'Could not load your training.');
      }
      // Local buffers are still readable when the server is not, and the unsent count is
      // exactly what the user needs to see in that situation.
      await readLocal().catch(() => undefined);
    }
  }, [handleFailure, readLocal, syncNow]);

  // First contact: ask whether the cookie is still good before showing anything. A snapshot
  // request would answer the same question, but with a 401 in the console on every cold start.
  useEffect(() => {
    void (async () => {
      try {
        const state = await sessionState();
        if (!state.authenticated) {
          setSession({ kind: 'signed-out' });
          await readLocal().catch(() => undefined);
          return;
        }
        await load();
      } catch (cause) {
        if (!handleFailure(cause)) setError('Could not reach the server.');
        setSession((prev) => (prev.kind === 'checking' ? { kind: 'signed-out' } : prev));
        await readLocal().catch(() => undefined);
      }
    })();
  }, [load, handleFailure, readLocal]);

  // Asked for once, early. Best-effort: the answer is reported in Settings rather than acted on.
  useEffect(() => {
    void requestPersistentStorage();
  }, []);

  /**
   * Reconnect: send what is queued.
   *
   * `drainOutbox` serialises against the load-time drain, so the two cannot overlap however
   * they interleave — see the note in `src/api/drain.ts`.
   */
  useEffect(() => {
    const onOnline = () => void syncNow(true);
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [syncNow]);

  // Fires immediately with the current value, so an update that landed before React mounted
  // is not lost.
  useEffect(() => subscribeUpdateReady(setUpdateReady), []);

  // Two tabs disagreeing about the local buffer's version. Nothing is done about it
  // automatically — closing this tab's connection could interrupt a workout — but the user is
  // told, because otherwise the other tab simply appears to hang on a blank screen.
  useEffect(() => onDatabaseConflict(setDbConflict), []);

  /**
   * The dataset as it should be shown: the server's state plus what this device is still
   * holding. Display only — see `applyPending`.
   */
  const shown = useMemo(
    () => (snapshot === null ? null : applyPending(snapshot, pending)),
    [snapshot, pending],
  );

  const state: State | null = useMemo(() => {
    if (shown === null) return null;
    const active = activeChallenges(shown);
    const labels = exerciseLabels(shown);
    const challenge = resolveSelectedChallenge(shown);
    if (!challenge) {
      return {
        active,
        challenge: undefined,
        labels,
        slots: [],
        workouts: [],
        currentSlot: undefined,
        attemptNo: 1,
        settings: shown.settings,
        exerciseLabel: '',
        totalWorkouts: shown.workouts.length,
      };
    }
    const slots = slotsFor(shown, challenge.id);
    const slot = pickCurrentSlot(slots);
    return {
      active,
      challenge,
      labels,
      slots,
      workouts: workoutsForChain(shown, challenge.chainId),
      currentSlot: slot,
      attemptNo: slot ? attemptsOn(shown, slot.id) + 1 : 1,
      settings: shown.settings,
      exerciseLabel: labels.get(challenge.exerciseId) ?? 'Exercise',
      totalWorkouts: shown.workouts.length,
    };
  }, [shown]);

  /**
   * Is there a workout to pick back up?
   *
   * Computed rather than stored, so it cannot go stale behind a refresh of the app's state.
   * Two filters do the work, and both are needed: the draft must belong to the session on
   * screen, and its id must not already be a saved workout — on the server, or queued here.
   */
  const offer = useMemo(
    () =>
      chooseDraftOffer({
        drafts,
        currentSlot: state?.currentSlot,
        // A draft whose workout is already in the history describes finished work. Matching
        // the current slot does not rule that out: a failed attempt leaves its slot current.
        loggedWorkoutIds: new Set([
          ...(state?.workouts ?? []).map((w) => w.id),
          ...pending.map((e) => e.id),
        ]),
        nowMs: Date.now(),
      }),
    [drafts, pending, state],
  );

  /**
   * Write the in-progress workout.
   *
   * A failure here is reported, never thrown: the workout carries on in memory, exactly as it
   * always used to, and the runner tells the user that closing the app would now cost them the
   * session.
   */
  const persistDraft = useCallback(async (draft: WorkoutDraftRecord) => {
    try {
      await saveDraft(draft);
      setDraftBroken(false);
    } catch {
      setDraftBroken(true);
    }
    // Keep the shell's copy in step with the runner's, so the "leave this workout?" dialog
    // counts the reps that are actually on disk. Guarded on the id: a write that lands after
    // the workout was saved must not put the session back on screen.
    setRun((prev) => (prev !== null && prev.id === draft.id ? draft : prev));
  }, []);

  const startRun = useCallback(
    async (targets: number[], adjustment: AdjustmentType) => {
      if (!state?.challenge || !state.currentSlot) return;
      // The workout's id is minted here, before a single rep is recorded, and it travels with
      // the draft all the way to the server. That is what makes saving idempotent.
      const draft = newDraft({
        id: newId('wo'),
        challengeId: state.challenge.id,
        chainId: state.challenge.chainId,
        slot: state.currentSlot,
        attemptNo: state.attemptNo,
        effectiveTargets: targets,
        adjustmentType: adjustment,
        restOverrideSeconds: state.settings.restOverrideSeconds,
        nowMs: Date.now(),
      });
      setDraftBroken(false);
      setSaveFailed(false);
      await persistDraft(draft);
      setRun(draft);
      setMessage(null);
      setView({ kind: 'runner' });
    },
    [state, persistDraft],
  );

  const resumeRun = useCallback((draft: WorkoutDraftRecord) => {
    setDismissedDraftId(null);
    setDraftBroken(false);
    setSaveFailed(false);
    setRun(draft);
    setMessage(null);
    setView({ kind: 'runner' });
  }, []);

  const discardRun = useCallback(
    async (draft: WorkoutDraftRecord) => {
      await deleteDraft(draft.id);
      setRun(null);
      setLeavePrompt(false);
      setDismissedDraftId(null);
      setView({ kind: 'tab', tab: 'today' });
      await readLocal();
      setMessage('That workout was discarded. Nothing was added to your history.');
    },
    [readLocal],
  );

  /**
   * The card's data, assembled from state the shell already holds. Built here rather than in
   * the sheet so the sheet stays a menu and the card stays a pure function of the history.
   */
  const card = useMemo(() => {
    if (!state?.challenge) return undefined;
    return buildShareCard({
      exerciseLabel: state.exerciseLabel,
      workouts: toStatWorkouts(state.workouts),
      slots: state.slots.map((s) => ({
        id: s.id,
        ordinal: s.ordinal,
        targetTotal: s.targetTotal,
        status: s.status,
      })),
      daysPerWeek: daysPerWeek(state.challenge),
    });
  }, [state]);

  const goToTab = useCallback((tab: Tab) => {
    rememberTab(tab);
    setView({ kind: 'tab', tab });
  }, []);

  /**
   * Run an ordinary command: it carries the revision, and its reply is the new truth.
   *
   * Nothing here retries and nothing reloads the page. A 409 puts the fresh snapshot on screen
   * and says so; the user decides what to do next.
   */
  const runCommand = useCallback(
    async (
      command: (revision: number) => Promise<{ snapshot: Snapshot }>,
      done?: string,
    ): Promise<boolean> => {
      if (snapshot === null) return false;
      setError(null);
      setConflicted(false);
      try {
        const result = await command(snapshot.revision);
        setSnapshot(result.snapshot);
        setOffline(false);
        if (done !== undefined) setMessage(done);
        return true;
      } catch (cause) {
        if (!handleFailure(cause)) {
          setError(cause instanceof Error ? cause.message : 'That did not work.');
        }
        return false;
      }
    },
    [snapshot, handleFailure],
  );

  const selectChallenge = useCallback(
    async (challengeId: string) => {
      setMessage(null);
      await runCommand((revision) => patchSettings({ selectedChallengeId: challengeId }, revision));
    },
    [runCommand],
  );

  const exportJson = useCallback(async () => {
    if (shown === null) return;
    // Built from `shown`, NOT from the raw snapshot, and this is the difference between a
    // complete backup and a nearly complete one. Codex caught it: exporting the server's view
    // while workouts were still queued here would write a file that silently omits exactly the
    // sessions that are least safe — the ones no server has yet. The backup is the second copy;
    // it does not get to be the incomplete one.
    //
    // The cost is that a queued workout's `attemptNo` in the file is the number `applyPending`
    // worked out rather than one the server assigned. That is the same `MAX + 1` rule the
    // server applies, it is stated in `applyPending`, and a guessed sequence number in a
    // recoverable file is a far smaller problem than a missing session.
    const backup = buildBackup(shown);
    // Name it from the very data being written, so the breadth in the filename cannot drift
    // from the breadth in the file.
    downloadFile(
      backupFilename(backup.exercises.map((e) => e.label)),
      JSON.stringify(backup, null, 2),
      'application/json',
    );
    setBackupDismissed(true);
    // The file is already on disk. Recording *when* is a server write, and it is allowed to
    // fail without turning a successful export into an error message.
    const recorded = await runCommand((revision) =>
      patchSettings({ lastBackupAt: new Date().toISOString() }, revision),
    );
    const queuedNote =
      pending.length === 0
        ? ''
        : ` It includes ${String(pending.length)} workout${pending.length === 1 ? '' : 's'} this ` +
          'device has not managed to send yet.';
    setMessage(
      (recorded
        ? 'Backup exported.'
        : 'Backup exported. The server could not record when, so it may nag you again.') +
        queuedNote,
    );
  }, [shown, pending, runCommand]);

  const exportCsv = useCallback(() => {
    if (!state?.challenge) return;
    const csv = buildCsv({
      exerciseLabel: state.exerciseLabel,
      goal: state.challenge.goalValue,
      challengeLength: `${state.slots.length} sessions`,
      workouts: state.workouts,
      slotsById: new Map(state.slots.map((s) => [s.id, s])),
    });
    downloadFile(csvFilename(state.exerciseLabel), csv, 'text/csv');
  }, [state]);

  /**
   * Finish a workout.
   *
   * The order below is the whole of the offline promise:
   *
   *   1. Compose the record, including its evaluation, from the prescription the user was
   *      actually shown. The id is the draft's, so a retry is the same command.
   *   2. Try to POST it. On 201 the server has it; the drafts go and the reply is the new state.
   *   3. On ANY failure — no network, a 500, an expired session, even a flat refusal — put it in
   *      the outbox and say so. A 401 queues it too: signing in must not cost a session.
   *
   * The only path that loses a workout is IndexedDB refusing the write as well, and that is the
   * one case the runner is kept on screen for, still holding the reps.
   */
  const finishWorkout = useCallback(
    async (
      performance: WorkoutPerformance,
      durationSeconds: number,
      options: { manual?: boolean; workoutId?: string } = {},
    ) => {
      if (!state?.challenge || !state.currentSlot) return;
      setSaveFailed(false);
      setError(null);

      const slot = state.currentSlot;
      const { workout, evaluation } = buildWorkout({
        workoutId: options.workoutId ?? newId('wo'),
        challenge: state.challenge,
        slot,
        performance,
        durationSeconds,
        settings: state.settings,
        ...(options.manual === true ? { manuallyAdvance: true } : {}),
      });

      // ONLY the POST is inside this try. It used to also cover the draft cleanup and the local
      // re-read, which meant an IndexedDB failure *after* a successful save fell into the queue
      // path and told the user the workout "could not be saved anywhere" while SQLite already
      // held it. Codex found that; the narrowed scope is the fix.
      let accepted: Awaited<ReturnType<typeof postWorkout>>;
      try {
        accepted = await postWorkout(workout);
      } catch (cause) {
        try {
          // Queued whatever went wrong, because the alternative is losing training that was
          // actually performed. The server dedupes on the id, so a workout that in fact landed
          // before the connection dropped will be recognised as a duplicate, not stored twice.
          await enqueueWorkout(workout, slot.id);
        } catch (queueFailure) {
          setSaveFailed(true);
          setError(
            queueFailure instanceof OutboxWriteError
              ? queueFailure.message
              : 'That workout could not be saved anywhere. Your reps are still here — try again.',
          );
          return;
        }

        setRun(null);
        goToTab('today');
        await readLocal().catch(() => undefined);

        if (cause instanceof ApiError && cause.kind === 'unauthorised') {
          setSession({
            kind: 'signed-out',
            reason:
              'Your session expired while saving. The workout is safe on this device and will ' +
              'be sent the moment you sign in.',
          });
          return;
        }
        if (cause instanceof ApiError && cause.kind === 'unreachable') setOffline(true);
        setMessage(
          `${evaluation.reason} Saved on this device — it is not on the server yet, and will be ` +
            'sent automatically.',
        );
        return;
      }

      // Saved. Everything below is tidying up after a workout the server already holds, so
      // nothing here may report a failure to save. A draft that survives a failed cleanup is
      // filtered out of the resume offer anyway: its id is a workout in the snapshot now.
      markWorkoutSettled(workout.id);
      setSnapshot(accepted.snapshot);
      setOffline(false);
      setRun(null);
      goToTab('today');
      setMessage(evaluation.reason);
      await clearDraftsForSlot(slot.id).catch(() => undefined);
      await readLocal().catch(() => undefined);
    },
    [state, goToTab, readLocal],
  );

  const advanceManually = useCallback(async () => {
    if (!state?.currentSlot) return;
    const targets = state.currentSlot.targets.map((t) => t.reps);
    await finishWorkout(
      {
        sets: targets.map((t, i) => ({ index: i + 1, effectiveTarget: t, actual: 0 })),
        actualTotal: 0,
        adjustmentType: 'none',
        effectiveTotal: state.currentSlot.targetTotal,
      },
      0,
      { manual: true },
    );
  }, [state, finishWorkout]);

  const endWorkout = useCallback(
    async (challengeId: string) => {
      // The selection is deliberately not cleared afterwards. `resolveSelectedChallenge` falls
      // back to the newest active challenge when the stored one is no longer active, so a
      // second command here would buy nothing and could fail on its own.
      await runCommand(
        (revision) =>
          endChallengeCommand(challengeId, {
            expectedRevision: revision,
            endReason: 'closed_manually',
            endedAt: new Date().toISOString(),
          }),
        'Workout ended. Its history stays in your backups.',
      );
    },
    [runCommand],
  );

  /**
   * What "Add another week" would append.
   *
   * Composed once, here, and the very records the user is shown are the records that get sent —
   * so the three totals on screen cannot be a different calculation from the one that lands.
   * Built from the challenge's `patternParams` alone: no workout is read, because a prescription
   * must never be derived from what was performed (IMP-07).
   *
   * A pattern with no notion of appending sessions yields nothing and says nothing — there is no
   * fault to report, and "Continue with a new block" is still there. A plan whose slots do not
   * account for every session its own parameters describe is a different matter: Codex noted that
   * swallowing that one leaves the owner staring at a missing button, so it carries its reason to
   * the screen.
   */
  const extension = useMemo((): { plan?: PlanExtension; problem?: string } => {
    if (!state?.challenge || state.currentSlot !== undefined) return {};
    try {
      return { plan: buildExtension({ challenge: state.challenge, existingSlots: state.slots }) };
    } catch (cause) {
      return cause instanceof PlanExtensionError && cause.reason === 'inconsistent'
        ? { problem: cause.message }
        : {};
    }
  }, [state]);

  const extendPlan = useCallback(async () => {
    const plan = extension.plan;
    if (plan === undefined) return;
    setMessage(null);
    await runCommand(
      (revision) =>
        extendChallengeCommand(plan.challenge.id, {
          expectedRevision: revision,
          challenge: plan.challenge,
          slots: plan.slots,
        }),
      `Another ${String(plan.slots.length)} sessions added. Your history is untouched.`,
    );
  }, [extension, runCommand]);

  const signOut = useCallback(async () => {
    try {
      await closeSession();
    } catch {
      // A sign-out that cannot reach the server still ends this app's session locally: the
      // cookie is HttpOnly, so the honest thing is to stop using it and say nothing more.
    }
    setSnapshot(null);
    setSession({ kind: 'signed-out' });
  }, []);

  // ── Screens ───────────────────────────────────────────────────────────────────

  if (session.kind === 'checking') return <Spinner label="Loading…" />;

  if (session.kind === 'incompatible') {
    return (
      <div className="mx-auto w-full px-4 py-10 md:max-w-lg">
        <Banner tone="warn">{session.message}</Banner>
      </div>
    );
  }

  if (session.kind === 'signed-out') {
    return (
      <>
        <SignIn reason={session.reason} onSignedIn={() => void load()} />
        {pending.length > 0 ? (
          <div className="mx-auto w-full px-4 pb-6 md:max-w-md">
            <Banner tone="info">
              {pending.length} finished workout{pending.length === 1 ? '' : 's'} waiting on this
              device. Signing in sends {pending.length === 1 ? 'it' : 'them'}.
            </Banner>
          </div>
        ) : null}
      </>
    );
  }

  if (state === null) {
    return (
      <div className="mx-auto w-full px-4 py-10 md:max-w-lg">
        {error ? <Banner tone="warn">{error}</Banner> : <Spinner label="Loading…" />}
        <div className="mt-4">
          <Button variant="ghost" className="w-full" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (!state.challenge && snapshot) {
    return <Welcome revision={snapshot.revision} onReady={() => void load()} />;
  }
  if (!state.challenge) return <Spinner label="Loading…" />;

  if (view.kind === 'runner' && state.currentSlot && run) {
    return (
      <>
        <Runner
          // Keyed by the workout id so resuming a different session remounts rather than
          // reusing the previous one's frozen prescription.
          key={run.id}
          draft={run}
          slot={state.currentSlot}
          exerciseLabel={state.exerciseLabel}
          persistFailed={draftBroken}
          saveFailed={saveFailed}
          onPersist={(draft) => void persistDraft(draft)}
          onFinish={(performance, duration) =>
            void finishWorkout(performance, duration, { workoutId: run.id })
          }
          onCancel={() => setLeavePrompt(true)}
        />
        {error ? (
          <div className="fixed inset-x-0 bottom-0 mx-auto w-full px-4 pb-4 md:max-w-lg safe-b">
            <Banner tone="warn" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          </div>
        ) : null}
        {leavePrompt ? (
          <LeaveRunnerDialog
            progress={draftProgress(run)}
            onStay={() => setLeavePrompt(false)}
            onKeep={() => {
              setLeavePrompt(false);
              setRun(null);
              // Shown once and left alone: Today's Start button brings the offer back.
              setDismissedDraftId(run.id);
              goToTab('today');
              void readLocal();
            }}
            onDiscard={() => void discardRun(run)}
          />
        ) : null}
      </>
    );
  }

  if (view.kind === 'add-workout' && snapshot) {
    return (
      <AddWorkout
        revision={snapshot.revision}
        onCancel={() => goToTab('today')}
        onDone={() => {
          goToTab('today');
          setMessage('Workout added.');
          void load();
        }}
      />
    );
  }

  if (view.kind === 'import-history' && snapshot) {
    return (
      <ImportHistory
        revision={snapshot.revision}
        onCancel={() => goToTab('settings')}
        onDone={() => {
          goToTab('today');
          setMessage('History imported.');
          void load();
        }}
      />
    );
  }

  if (view.kind === 'continue') {
    return (
      <ContinueBlock
        challenge={state.challenge}
        workouts={state.workouts}
        onCancel={() => goToTab('today')}
        onConfirm={async (baselineValue, tested, goal, weeks, daysPerWeekValue) => {
          // One command: ending the old block, recording the max test, creating the successor
          // and its slots, and moving the selection all land together or not at all.
          let plan: ReturnType<typeof buildNextBlock>;
          try {
            plan = buildNextBlock({
              previous: state.challenge!,
              strategy: tested ? 'retest' : 'user_entered',
              baselineValue,
              goalValue: goal,
              weeks,
              daysPerWeek: daysPerWeekValue,
              tested,
            });
          } catch (e) {
            setError(e instanceof Error ? e.message : 'The next block could not be started.');
            return;
          }

          const ok = await runCommand(
            (revision) =>
              startNextBlockCommand({
                expectedRevision: revision,
                previousChallengeId: state.challenge!.id,
                endedAt: plan.endedAt,
                ...(plan.performanceTest === undefined
                  ? {}
                  : { performanceTest: plan.performanceTest }),
                challenge: plan.challenge,
                slots: plan.slots,
              }),
            'New block started.',
          );
          if (ok) goToTab('today');
        }}
      />
    );
  }

  const activeTab = view.kind === 'tab' ? view.tab : 'today';
  const showBackupNag =
    !backupDismissed && shouldPromptBackup(state.settings, state.totalWorkouts);
  const blocked = pending.filter((entry) => entry.blockedReason !== undefined);

  const tabOptions = TABS.map((tab) => ({
    value: tab,
    label: <span className="capitalize">{tab}</span>,
  }));

  return (
    <div className="mx-auto flex min-h-screen w-full flex-col px-4 md:max-w-3xl lg:max-w-6xl safe-t">
      <header className="flex items-center justify-between gap-3 pb-4">
        <h1 className="text-xl font-bold tracking-tight text-slate-100">
          GODMODE
          <span className="ml-2 text-xs font-normal uppercase tracking-[0.18em] text-teal-300">
            No More Later
          </span>
        </h1>

        {/*
          Below md this wrapper holds only the share icon, so it lands top-right on a phone;
          from md up the tab row sits beside it. The sheet it opens is a bottom sheet, which is
          what puts the actions back under the thumb.
        */}
        <div className="flex items-center gap-2">
          {/* Desktop keeps navigation at the top; the phone keeps it under the thumb. */}
          <nav className="hidden md:block">
            <Segmented
              ariaLabel="Sections"
              value={activeTab}
              onChange={goToTab}
              options={tabOptions}
            />
          </nav>
          <Button
            variant="subtle"
            ariaLabel="Share and export"
            className="min-h-11 px-2"
            onClick={() => setShareOpen(true)}
          >
            <ShareGlyph />
          </Button>
        </div>
      </header>

      {shouldShowWorkoutBar({ tab: activeTab, activeCount: state.active.length }) ? (
        <div className="pb-3">
          <WorkoutBar
            active={state.active}
            labels={state.labels}
            selectedId={state.challenge.id}
            onSelect={(id) => void selectChallenge(id)}
            onAddWorkout={() => setView({ kind: 'add-workout' })}
          />
        </div>
      ) : null}

      {/*
        The four server states, each said once and in the user's terms. Unsent workouts come
        first because they are the only one that is about their training rather than about the
        app's plumbing.
      */}
      {pending.length > 0 ? (
        <div className="pb-3">
          <Banner tone="info">
            {pending.length} finished workout{pending.length === 1 ? '' : 's'} saved on this
            device only.{' '}
            <button type="button" className="underline" onClick={() => void syncNow(true)}>
              Send now
            </button>
            {blocked.length > 0 ? (
              <>
                {' '}
                {blocked.length} of {pending.length === blocked.length ? 'them' : 'those'} the
                server refused: {blocked[0]?.blockedReason ?? ''}{' '}
                {/*
                  The way back out. A workout is normally refused because of something that can
                  be put right — the challenge was ended on the other device, so the slot it
                  names is gone — and once it is, the same command would be accepted. Without
                  this the entry is kept for ever and unreachable, which is barely better than
                  losing it.
                */}
                <button
                  type="button"
                  className="underline"
                  onClick={() =>
                    void (async () => {
                      await unblockAll().catch(() => 0);
                      await syncNow(true);
                    })()
                  }
                >
                  Try them again
                </button>
              </>
            ) : null}
          </Banner>
        </div>
      ) : null}

      {offline ? (
        <div className="pb-3">
          <Banner tone="warn" onDismiss={() => setOffline(false)}>
            The server is not answering. You can still train — anything you finish is kept here
            and sent when it comes back.
          </Banner>
        </div>
      ) : null}

      {conflicted ? (
        <div className="pb-3">
          <Banner tone="warn" onDismiss={() => setConflicted(false)}>
            Your other device changed something first. What is on screen is now the latest —
            check it, then try again.
          </Banner>
        </div>
      ) : null}

      {error ? (
        <div className="pb-3">
          <Banner tone="warn" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        </div>
      ) : null}

      {/*
        Two tabs, two versions of the app. Nothing is closed or reloaded automatically — a
        workout could be running in either one — so the only honest thing to do is name it.
      */}
      {dbConflict !== null ? (
        <div className="pb-3">
          <Banner tone="warn" onDismiss={() => setDbConflict(null)}>
            {dbConflict === 'blocked'
              ? 'This app is open in another tab on an older version. Close that tab and reload here.'
              : 'Another tab is waiting to update this app. Close this one when you are finished.'}
          </Banner>
        </div>
      ) : null}

      {/*
        This app never reloads itself. Runner.tsx persists a draft as it goes, so a reload no
        longer destroys the reps — but it still throws away the running session: the rest clock,
        the set the user is standing in, and anything typed but not yet committed. The reload is
        always the user's tap.

        `workoutInProgress` is passed even though this render site already sits after the
        `view.kind === 'runner'` early return, so the banner is structurally unreachable during
        a workout. Stating the guarantee in code — and pinning it in policy.test.ts — is worth
        more than trusting the ordering of early returns in a long file to stay put.

        No onDismiss: a dismissed update is an update the user never gets, and this app is
        handed out once as a link.
      */}
      {shouldOfferUpdate({ updateReady, workoutInProgress: view.kind === 'runner' }) ? (
        <div className="pb-3">
          <Banner tone="info">
            A newer version is ready.{' '}
            <button type="button" className="underline" onClick={() => applyUpdate()}>
              Reload to update
            </button>
            .
          </Banner>
        </div>
      ) : null}

      {showBackupNag ? (
        <div className="pb-3">
          <Banner tone="warn" onDismiss={() => setBackupDismissed(true)}>
            No backup yet.{' '}
            <button type="button" className="underline" onClick={() => void exportJson()}>
              Export a backup
            </button>
            .
          </Banner>
        </div>
      ) : null}

      <main className="flex-1 pb-4">
        {activeTab === 'today' ? (
          <Today
            challenge={state.challenge}
            slot={state.currentSlot}
            attemptNo={state.attemptNo}
            exerciseLabel={state.exerciseLabel}
            slotsAdvanced={state.slots.filter((s) => s.status === 'completed').length}
            slotsTotal={state.slots.length}
            lastMessage={message}
            extension={extension.plan?.slots.map((s) => ({
              ordinal: s.ordinal,
              week: s.week,
              day: s.day,
              targetTotal: s.targetTotal,
            }))}
            extensionProblem={extension.problem}
            onDismissMessage={() => setMessage(null)}
            onStart={(targets, adjustment) => {
              // An unfinished session for this very day is not something to start over
              // silently. Put the choice back in front of the user instead.
              if (offer.kind === 'offer') {
                setDismissedDraftId(null);
                return;
              }
              void startRun(targets, adjustment);
            }}
            onAdvanceManually={() => void advanceManually()}
            onExtend={() => void extendPlan()}
            onContinueChain={() => setView({ kind: 'continue' })}
            onShare={() => setShareOpen(true)}
          />
        ) : null}

        {activeTab === 'history' ? (
          <History
            workouts={state.workouts}
            slots={state.slots}
            daysPerWeek={daysPerWeek(state.challenge)}
            onShare={() => setShareOpen(true)}
          />
        ) : null}

        {activeTab === 'settings' ? (
          <Settings
            settings={state.settings}
            workoutCount={state.workouts.length}
            unsentCount={pending.length}
            active={state.active}
            labels={state.labels}
            onEndWorkout={(id) => void endWorkout(id)}
            onSave={(patch) => {
              void runCommand((revision) => patchSettings(patch, revision), 'Saved.');
            }}
            onOpenExport={() => setShareOpen(true)}
            onImportHistory={() => setView({ kind: 'import-history' })}
            onSignOut={() => void signOut()}
          />
        ) : null}
      </main>

      <nav className="sticky bottom-0 -mx-4 border-t border-[#26324b] bg-[#0b1220]/95 px-4 backdrop-blur md:hidden safe-b">
        <div className="flex gap-1 pt-2">
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => goToTab(tab)}
              className={[
                'min-h-11 flex-1 rounded-xl py-2 text-sm capitalize transition-colors',
                activeTab === tab
                  ? 'bg-[#1c2740] font-semibold text-teal-300'
                  : 'text-slate-400 hover:text-slate-200',
              ].join(' ')}
            >
              {tab}
            </button>
          ))}
        </div>
      </nav>

      {/*
        The recovered workout. Offered, never applied — and offered here, over Today, rather
        than by dropping the user into a runner they did not ask for.
      */}
      {offer.kind === 'offer' && offer.draft.id !== dismissedDraftId ? (
        <ResumeDialog
          draft={offer.draft}
          progress={offer.progress}
          stale={offer.stale}
          nowMs={Date.now()}
          onResume={() => resumeRun(offer.draft)}
          onDiscard={() => void discardRun(offer.draft)}
          onDismiss={() => setDismissedDraftId(offer.draft.id)}
        />
      ) : null}

      {shareOpen ? (
        <ExportSheet
          onClose={() => setShareOpen(false)}
          onExportCsv={exportCsv}
          onExportJson={() => void exportJson()}
          canExportCsv={state.challenge !== undefined}
          {...(card === undefined ? {} : { card })}
        />
      ) : null}
    </div>
  );
}

/**
 * Three nodes, two strokes. Drawn inline rather than pulled from an icon set — this app has no
 * icon dependency and is not acquiring one for a single glyph.
 */
function ShareGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="M8.2 10.8 15.8 6.5" />
      <path d="M8.2 13.2 15.8 17.5" />
    </svg>
  );
}

/** Two strokes. Drawn inline, for the same reason as ShareGlyph. */
function PlusGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

/**
 * A chip per active workout, plus the app's only "add a workout" control.
 *
 * Renders from one workout upward — not only when there is a choice to make — precisely
 * because it hosts that control: hiding the row from a user with a single workout would leave
 * them no route to a second. With one workout the chip stays and the `+` sits beside it. A
 * bare `+` floating above the content would name nothing, and the row's layout would jump the
 * instant a second workout appeared.
 *
 * The add button is a *sibling* of the tablist, never a child. A non-tab inside
 * `role="tablist"` is invalid ARIA and misreads to assistive tech.
 */
function WorkoutBar({
  active,
  labels,
  selectedId,
  onSelect,
  onAddWorkout,
}: {
  active: ChallengeRecord[];
  labels: Map<string, string>;
  selectedId: string;
  onSelect: (challengeId: string) => void;
  onAddWorkout: () => void;
}) {
  // items-stretch, not items-center, and it is there for the add button specifically: that
  // button has no line box of its own, so it would sit at its min-h-9 floor while the chips are
  // pushed past it by their 24px line box. Stretching lets it inherit whatever height the chips
  // settle at instead of restating it. With ADD_WORKOUT_ENABLED false the row is chips only and
  // this makes no visible difference — it is kept so re-enabling the button stays a one-word
  // change rather than a one-word change plus a layout regression.
  return (
    <div className="flex flex-wrap items-stretch gap-2">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Workout">
        {active.map((challenge) => {
          const isSelected = challenge.id === selectedId;
          return (
            <button
              key={challenge.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              onClick={() => onSelect(challenge.id)}
              className={[
                'min-h-9 rounded-xl border px-3 py-1.5 text-sm transition-colors',
                isSelected
                  ? 'border-teal-400/50 bg-teal-300/10 font-semibold text-teal-200'
                  : 'border-[#33405c] text-slate-300 hover:bg-[#1c2740]',
              ].join(' ')}
            >
              {labels.get(challenge.exerciseId) ?? 'Exercise'}
            </button>
          );
        })}
      </div>

      {/*
        Deliberately a plain button carrying the chip's own geometry rather than the kit Button:
        it sits in the chip row and should read as one of them. Its own inline-flex centres the
        glyph inside the height the row hands it. It stays outside the tablist — it selects
        nothing. If the chips wrap, this drops to its own flex line rather than stretching to
        the wrapped block, which is why stretching is safe here.

        Hidden while ADD_WORKOUT_ENABLED is false — see the flag for why, and note that the
        markup is kept rather than deleted so restoring it costs nothing.
      */}
      {ADD_WORKOUT_ENABLED ? (
        <button
          type="button"
          aria-label="Add a workout"
          onClick={onAddWorkout}
          className="inline-flex min-h-9 items-center justify-center rounded-xl border border-[#33405c] px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-[#1c2740]"
        >
          <PlusGlyph />
        </button>
      ) : null}
    </div>
  );
}

function ContinueBlock({
  challenge,
  workouts,
  onCancel,
  onConfirm,
}: {
  challenge: ChallengeRecord;
  workouts: WorkoutRecord[];
  onCancel: () => void;
  onConfirm: (
    baseline: number,
    tested: boolean,
    goal: number,
    weeks: number,
    daysPerWeek: number,
  ) => void;
}) {
  const bestAmrap = useMemo(() => {
    let best = 0;
    for (const w of workouts) {
      for (const s of w.sets) best = Math.max(best, s.actual);
    }
    return best;
  }, [workouts]);

  const [tested, setTested] = useState<number | ''>('');
  const [goal, setGoal] = useState<number | ''>((challenge.goalValue ?? 100) + 25);
  const [weeks, setWeeks] = useState<number | ''>(6);
  const [daysPerWeek, setDaysPerWeek] = useState<number | ''>(3);
  const [useTest, setUseTest] = useState(true);

  return (
    <div className="mx-auto w-full px-4 pb-10 md:max-w-2xl safe-t">
      <header className="py-6">
        <h2 className="text-2xl font-semibold text-slate-100">Keep going</h2>
        <p className="mt-1 text-sm text-slate-400">Your history carries over.</p>
      </header>

      <div className="flex flex-col gap-4">
        <Card>
          <h3 className="font-semibold text-slate-100">Retest your max</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
            One rested set to failure. Your best single set so far was{' '}
            <span className="tnum font-semibold text-slate-100">{bestAmrap}</span>, but that came
            at the end of a full session — rested you'll manage more.
          </p>
          <div className="mt-4">
            <NumberField
              label={useTest ? 'Rested max test result' : 'Baseline (entered by hand)'}
              value={tested}
              min={1}
              onChange={setTested}
              suffix="reps"
            />
          </div>
          <button
            type="button"
            className="mt-2 text-xs text-slate-400 underline"
            onClick={() => setUseTest((v) => !v)}
          >
            {useTest ? 'I did not test — let me just enter a number' : 'I did test this properly'}
          </button>
        </Card>

        <Card>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <NumberField label="New goal" value={goal} min={1} onChange={setGoal} suffix="reps" />
            <NumberField label="Weeks" value={weeks} min={1} onChange={setWeeks} />
            <NumberField
              label="Days / week"
              value={daysPerWeek}
              min={1}
              onChange={setDaysPerWeek}
            />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-400">
            Set the goal to match your baseline to hold steady instead of climbing.
          </p>
        </Card>

        <div className="flex gap-3">
          <Button variant="ghost" onClick={onCancel}>
            Back
          </Button>
          <Button
            className="flex-1"
            disabled={tested === '' || goal === '' || weeks === '' || daysPerWeek === ''}
            onClick={() =>
              onConfirm(
                Number(tested),
                useTest,
                Number(goal),
                Number(weeks),
                Number(daysPerWeek),
              )
            }
          >
            Start the next block
          </Button>
        </div>
      </div>
    </div>
  );
}
