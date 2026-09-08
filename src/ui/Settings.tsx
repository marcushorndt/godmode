/**
 * Settings and backup.
 *
 * Restore and "delete everything" are gone from this screen, and their absence is deliberate
 * rather than an omission. Both were IndexedDB operations on a database that is no longer the
 * dataset: restore cleared six stores and rewrote them, and the reset wiped all seven. The API
 * has no equivalent command — see the note in `src/data/exchange.ts` — and approximating a
 * transaction the server does not offer, on the only copy of someone's history, is exactly the
 * kind of thing that loses it. Restoring is `npm run import-backup`, which verifies the whole
 * file before it replaces anything.
 *
 * What is left of the durability warning still belongs here: an unsent workout lives in this
 * browser until the server takes it, and iOS can clear that.
 */

import { useState } from 'react';
import { daysSinceBackup } from '../data/exchange.js';
import type { ChallengeRecord, SettingsRecord } from '../db/schema.js';
import { Banner, Button, Card, NumberField, Segmented } from './kit.js';

export function Settings({
  settings,
  workoutCount,
  unsentCount,
  active,
  labels,
  onEndWorkout,
  onSave,
  onOpenExport,
  onImportHistory,
  adaptive,
  onSetAdaptive,
  onSignOut,
}: {
  settings: SettingsRecord;
  workoutCount: number;
  /** Finished workouts this device is still holding. Zero, almost always. */
  unsentCount: number;
  active: ChallengeRecord[];
  labels: Map<string, string>;
  onEndWorkout: (challengeId: string) => void;
  onSave: (patch: Partial<SettingsRecord>) => void;
  onOpenExport: () => void;
  onImportHistory: () => void;
  /** Whether the showing workout's plan follows your training. Undefined when it cannot. */
  adaptive: boolean | undefined;
  onSetAdaptive: (on: boolean) => void;
  onSignOut: () => void;
}) {
  const [bodyweight, setBodyweight] = useState<number | ''>(settings.bodyweightKg ?? '');
  const [restOverride, setRestOverride] = useState<number | ''>(
    settings.restOverrideSeconds ?? '',
  );
  const [confirmEnd, setConfirmEnd] = useState<string | null>(null);

  const days = daysSinceBackup(settings);

  return (
    // Columns, not a grid. A two-column grid puts each card in a row whose height is set by
    // the taller of the pair, so a short card leaves a gap under it and the column bottoms
    // drift apart. A multi-column flow packs the cards continuously instead, which is what
    // suits a stack of unrelated widgets with very different heights. `break-inside-avoid`
    // on each card is what stops one being split down the middle across the column boundary.
    // Below lg it stays a single flex column — two columns of this width would be cramped.
    <div className="flex flex-col gap-4 lg:block lg:columns-2 lg:gap-4">
      <Card className="lg:mb-4 lg:break-inside-avoid">
        {/*
          An inventory, not a selector. The workout row above Today and History owns selection
          outright, and it hosts the "add a workout" control that used to sit in this header —
          one fact, one idiom, one place.
        */}
        <h3 className="font-semibold text-slate-100">Your workouts</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          Anything you can count gets its own plan and its own history. Sit-ups, squats,
          pull-ups, dips.
        </p>

        <ul className="mt-4 flex flex-col divide-y divide-[#26324b]">
          {active.map((challenge) => {
            const label = labels.get(challenge.exerciseId) ?? 'Exercise';
            return (
              <li key={challenge.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-100">{label}</div>
                  <div className="tnum mt-0.5 text-xs text-slate-400">
                    from {challenge.baseline.value} toward {challenge.goalValue ?? '—'} · started{' '}
                    {challenge.startedAt.slice(0, 10)}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="subtle" onClick={() => setConfirmEnd(challenge.id)}>
                    End
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>

        {confirmEnd ? (
          <div className="mt-4 flex flex-col gap-3">
            <Banner tone="warn">
              Ending {labels.get(active.find((c) => c.id === confirmEnd)?.exerciseId ?? '') ?? 'it'}{' '}
              stops its plan. The sessions you have logged stay in your history and your backups.
            </Banner>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setConfirmEnd(null)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                className="flex-1"
                onClick={() => {
                  onEndWorkout(confirmEnd);
                  setConfirmEnd(null);
                }}
              >
                End it
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      {/*
        Import lives here, not behind the hidden "+". Those were one control and are two
        promises: creating a plan is hidden because it can only build one shape, while bringing
        history across has nothing to do with plan variety and is the thing this app exists for.
        Hiding the one silently removed the other, and a friend with months of history in the
        old app had no way in at all.
      */}
      <Card className="lg:mb-4 lg:break-inside-avoid">
        <h3 className="font-semibold text-slate-100">Bring history across</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          Export the CSV from your old app and load it here. It arrives as its own workout, with
          its own plan and history — nothing you already have is touched.
        </p>
        <div className="mt-4">
          <Button variant="ghost" className="w-full" onClick={onImportHistory}>
            Import a CSV…
          </Button>
        </div>
      </Card>

      {/*
        Two modes, one switch, and the copy is careful about which is which. "Follows your
        training" is what it does; "learns" is what it does not do, and this project has a
        documented habit of overstating exactly this kind of claim.
      */}
      {adaptive === undefined ? null : (
        <Card className="lg:mb-4 lg:break-inside-avoid">
          <h3 className="font-semibold text-slate-100">How the plan progresses</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
            The standard plan climbs on a fixed curve and reaches your goal in six weeks, whoever
            you are. If that curve outruns you, every session becomes one you fail.
          </p>
          <div className="mt-4">
            <Segmented
              ariaLabel="How the plan progresses"
              value={adaptive ? 'adaptive' : 'fixed'}
              onChange={(value) => onSetAdaptive(value === 'adaptive')}
              options={[
                { value: 'fixed', label: 'Fixed curve' },
                { value: 'adaptive', label: 'Follow me' },
              ]}
            />
          </div>
          <p className="mt-3 text-sm leading-relaxed text-slate-300">
            {adaptive
              ? 'Your plan is following you. Sessions ahead are re-priced after each one you ' +
                'finish, and Today shows where the block is heading. Days you have already ' +
                'trained are never changed, and a target never goes down.'
              : 'Switching to "Follow me" keeps your goal and the length of the block. It changes ' +
                'how fast the sessions climb toward it, based on how the ones you finish actually ' +
                'go. Your next session will not get harder.'}
          </p>
        </Card>
      )}

      <Card className="lg:mb-4 lg:break-inside-avoid">
        <h3 className="font-semibold text-slate-100">Backups</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          Your history lives on your server, in a SQLite file you can copy. A backup here is a
          second copy you hold yourself — take one now and then.
        </p>
        <div className="mt-3 text-xs text-slate-400">
          {days === null
            ? workoutCount > 0
              ? 'You have never exported a backup.'
              : 'Nothing to back up yet.'
            : days === 0
              ? 'Last backup: today.'
              : `Last backup: ${days} day${days === 1 ? '' : 's'} ago.`}
        </div>
        <div className="mt-4">
          <Button className="w-full" onClick={onOpenExport}>
            Export…
          </Button>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-slate-400">
          Restoring one is done on the server, not here:{' '}
          <code className="rounded bg-[#0f1728] px-1 py-0.5">
            npm run import-backup -- backup.json --target godmode.sqlite --dry-run
          </code>
          . It checks every record, builds a new database, verifies it, and only then puts it in
          place — keeping whatever was there before.
        </p>
      </Card>

      <Card className="lg:mb-4 lg:break-inside-avoid">
        <h3 className="font-semibold text-slate-100">Unsent workouts</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          A workout you finish with no connection is kept in this browser until the server takes
          it. That is the one thing here iOS can still clear, so do not reinstall or clear site
          data while any are waiting.
        </p>
        <div className="tnum mt-3 text-sm text-slate-200">
          {unsentCount === 0
            ? 'Nothing waiting — everything is on the server.'
            : `${unsentCount} waiting to be sent.`}
        </div>
      </Card>

      <Card className="lg:mb-4 lg:break-inside-avoid">
        <h3 className="font-semibold text-slate-100">Calories</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          A rough estimate, about {settings.kcalCoefficient} kcal per rep per kilo of
          bodyweight.
        </p>
        <div className="mt-4">
          <NumberField
            label="Bodyweight"
            value={bodyweight}
            min={20}
            max={400}
            onChange={setBodyweight}
            suffix="kg"
            hint="Used only for the calorie estimate."
          />
        </div>
        <Button
          variant="ghost"
          className="mt-3 w-full"
          onClick={() =>
            onSave({
              ...(bodyweight === '' ? {} : { bodyweightKg: Number(bodyweight) }),
            })
          }
        >
          Save
        </Button>
      </Card>

      <Card className="lg:mb-4 lg:break-inside-avoid">
        <h3 className="font-semibold text-slate-100">Rest between sets</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          Rest grows with the size of the session — around 30 seconds early on, about two and
          a half minutes by the end.
        </p>
        <div className="mt-4">
          <NumberField
            label="Fixed rest (leave empty to use the curve)"
            value={restOverride}
            min={0}
            max={600}
            onChange={setRestOverride}
            suffix="sec"
          />
        </div>
        <Button
          variant="ghost"
          className="mt-3 w-full"
          onClick={() =>
            onSave(
              restOverride === ''
                ? { restOverrideSeconds: undefined }
                : { restOverrideSeconds: Number(restOverride) },
            )
          }
        >
          Save
        </Button>
      </Card>

      <Card className="lg:mb-4 lg:break-inside-avoid">
        <h3 className="font-semibold text-slate-100">About</h3>
        <dl className="mt-3 flex flex-col gap-2 text-sm">
          {/*
            No "Exercise" or session-count rows here. Both restated what the workouts card
            above already shows, and About is for facts about the app, not about the data.
          */}
          <div className="flex justify-between gap-3">
            <dt className="text-slate-400">Licence</dt>
            <dd className="text-slate-200">AGPL-3.0</dd>
          </div>
        </dl>
      </Card>

      <Card className="lg:mb-4 lg:break-inside-avoid">
        <h3 className="font-semibold text-slate-100">This device</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
          Signing out ends the session on the server and forgets it here. Your training is not
          touched — it is on the server, not in this browser.
        </p>
        <Button
          variant="ghost"
          className="mt-4 w-full"
          disabled={unsentCount > 0}
          onClick={onSignOut}
        >
          Sign out
        </Button>
        {unsentCount > 0 ? (
          <p className="mt-2 text-xs leading-relaxed text-amber-300">
            Not while {unsentCount} workout{unsentCount === 1 ? '' : 's'} still needs sending.
          </p>
        ) : null}
      </Card>
    </div>
  );
}
