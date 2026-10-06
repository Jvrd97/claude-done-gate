import { atom, read, update } from 'claude-code'
import type { ClassicEventOf, CommandRunInput, EngineInterface, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import type { DoneGateRun } from '../types'
import {
  blockReason,
  denyReason,
  detectCommand,
  failToast,
  giveUpToast,
  hasWildcard,
  isPassing,
  isTestPath,
  joinPath,
  matchersOf,
  NO_COMMAND_TOAST,
  passToast,
  PROBE_FILES,
  relativeTo,
  settingsOf,
  shellEffects,
  statusReport,
  tailOf,
} from './logic'
import type { CheckCommand, LockState, ProbeFile, Settings } from './logic'

const STATUS_COMMAND = 'done-gate'
const UNLOCK_COMMAND = 'unlock-tests'
const LOCK_COMMAND = 'lock-tests'
const TOAST_MS = 6_000
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
/** Who may unlock: the person at the prompt, the Remote Control bridge, or a `claude -p` run. Never the model or a relay. */
const UNLOCKING_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

const lockOverride = atom({ plugin: 'done-gate', key: 'lockOverride' } as const, null)
const created = atom({ plugin: 'done-gate', key: 'created' } as const, [])
const hasChanges = atom({ plugin: 'done-gate', key: 'hasChanges' } as const, false)
const rounds = atom({ plugin: 'done-gate', key: 'rounds' } as const, { promptId: null, count: 0 })
const lastRun = atom({ plugin: 'done-gate', key: 'lastRun' } as const, null)
const hasSaidNoCommand = atom({ plugin: 'done-gate', key: 'hasSaidNoCommand' } as const, false)

type StopInput = ClassicEventOf['classic.Stop']

/** The verdict on one tool call: refuse it, let it create a new test file, or let it be. */
type Guard = { kind: 'deny'; reason: string } | { kind: 'new-test'; path: string } | { kind: 'pass' }

const PASS: Guard = { kind: 'pass' }

/** The file an editing tool touches, read loosely: MultiEdit is not a built-in of every build. */
const editTargetOf = (e: ToolCallInput): string | null => {
  if (!EDIT_TOOLS.has(e.tool)) {
    return null
  }

  const args = e as Readonly<Record<string, unknown>>
  const path = args.file_path ?? args.notebook_path

  return typeof path === 'string' ? path : null
}

async function lockOf($: EngineInterface, settings: Settings): Promise<LockState> {
  const override = await read($, lockOverride)

  return override === null ? { isLocked: settings.lockTests, isOverridden: false } : { isLocked: override, isOverridden: true }
}

/** A path the guard cannot stat counts as existing: the lock errs on the side of refusing. */
async function existsOrUnknown($: EngineInterface, path: string): Promise<boolean> {
  if (hasWildcard(path)) {
    return true
  }

  return $.fs.exists(path).catch(() => true)
}

async function guardEdit($: EngineInterface, path: string, root: string, settings: Settings): Promise<Guard> {
  const absolute = joinPath(root, path)
  const relative = relativeTo(root, absolute)

  if (!isTestPath(relative, matchersOf(settings.globs)) || (await read($, created)).includes(absolute)) {
    return PASS
  }

  return (await existsOrUnknown($, absolute)) ? { kind: 'deny', reason: denyReason('edit of', relative) } : { kind: 'new-test', path: absolute }
}

async function guardShell($: EngineInterface, command: string, root: string, settings: Settings): Promise<Guard> {
  const matchers = matchersOf(settings.globs)
  const own = await read($, created)

  for (const target of shellEffects(command, root).targets) {
    const relative = relativeTo(root, target.path)

    if (!isTestPath(relative, matchers) || own.includes(target.path)) {
      continue
    }

    if (target.kind === 'remove') {
      return { kind: 'deny', reason: denyReason('removing or moving', relative) }
    }

    if (await existsOrUnknown($, target.path)) {
      return { kind: 'deny', reason: denyReason('shell write into', relative) }
    }
  }

  return PASS
}

async function guard($: EngineInterface, e: ToolCallInput, settings: Settings): Promise<Guard> {
  if (!(await lockOf($, settings)).isLocked) {
    return PASS
  }

  const path = editTargetOf(e)

  if (path !== null) {
    return guardEdit($, path, await $.session.root(), settings)
  }

  return e.tool === 'Bash' ? guardShell($, e.command, await $.session.root(), settings) : PASS
}

/** Marks the turn as having changed files once a call that may have changed them went through. */
async function noteChange($: EngineInterface, e: ToolCallInput, result: ToolCallResult, verdict: Guard): Promise<void> {
  if (result.deny !== undefined) {
    return
  }

  if (verdict.kind === 'new-test' && result.isError !== true) {
    await update($, created, list => [...list, verdict.path])
  }

  if (editTargetOf(e) !== null) {
    if (result.isError !== true) {
      await update($, hasChanges, () => true)
    }

    return
  }

  // A failing command may still have written before it failed, so an error does not clear it.
  if (e.tool === 'Bash' && result.isReadOnly !== true && shellEffects(e.command, await $.session.root()).isWrite) {
    await update($, hasChanges, () => true)
  }
}

async function probeProject($: EngineInterface, root: string): Promise<{ present: Set<ProbeFile>; packageJson: string | null }> {
  const present = new Set<ProbeFile>()

  for (const name of PROBE_FILES) {
    if (await $.fs.exists(joinPath(root, name)).catch(() => false)) {
      present.add(name)
    }
  }

  const packageJson = present.has('package.json') ? await $.fs.read(joinPath(root, 'package.json')).catch(() => null) : null

  return { present, packageJson }
}

async function resolveCheck($: EngineInterface, root: string, settings: Settings): Promise<CheckCommand | null> {
  if (settings.checkCommand !== '') {
    return { command: settings.checkCommand, source: 'setting' }
  }

  return detectCommand(await probeProject($, root))
}

async function runCheck($: EngineInterface, check: CheckCommand, root: string, settings: Settings): Promise<DoneGateRun> {
  const startedAt = await $.clock.now()
  const outcome = await $.process
    .run(['sh', '-c', check.command], { cwd: root, timeoutMs: settings.timeoutMs })
    .then(ran => ({ exitCode: ran.exitCode, tail: tailOf(ran.stdout, ran.stderr) }))
    .catch((error: unknown) => ({
      exitCode: null,
      tail: `done-gate could not finish \`${check.command}\` within ${settings.timeoutMs / 1000}s: ${error instanceof Error ? error.message : String(error)}`,
    }))
  const at = await $.clock.now()

  return { at, command: check.command, exitCode: outcome.exitCode, durationMs: at - startedAt, isPassed: isPassing(outcome.exitCode, check), tail: outcome.tail }
}

/** Ends a stop sequence: the model may stop, and the next one starts counting rounds from zero. */
async function release($: EngineInterface, promptId: string | null): Promise<null> {
  await update($, hasChanges, () => false)
  await update($, rounds, () => ({ promptId, count: 0 }))

  return null
}

/** Runs the checks when the model wants to stop after changing files; answers the block reason, or null to let it stop. */
async function gate($: EngineInterface, e: StopInput, settings: Settings): Promise<string | null> {
  const promptId = e.prompt_id ?? null
  const counted = await read($, rounds)

  // A new prompt starts a new sequence; a continuation (stop_hook_active) never does, so the cap always holds.
  if (!e.stop_hook_active && counted.promptId !== promptId) {
    await update($, rounds, () => ({ promptId, count: 0 }))
  }

  if (!settings.isGateOn || !(await read($, hasChanges))) {
    return null
  }

  const root = await $.session.root()
  const check = await resolveCheck($, root, settings)

  if (check === null) {
    if (!(await read($, hasSaidNoCommand))) {
      await update($, hasSaidNoCommand, () => true)
      $.ui.toast(NO_COMMAND_TOAST, { timeoutMs: TOAST_MS })
    }

    return release($, promptId)
  }

  const run = await runCheck($, check, root, settings)
  await update($, lastRun, () => run)

  if (run.isPassed) {
    $.ui.toast(passToast(run), { timeoutMs: TOAST_MS })

    return release($, promptId)
  }

  const used = (await read($, rounds)).count

  if (used >= settings.maxRounds) {
    $.ui.toast(giveUpToast(settings.maxRounds), { timeoutMs: TOAST_MS })

    return release($, promptId)
  }

  await update($, rounds, () => ({ promptId, count: used + 1 }))
  $.ui.toast(failToast(run, settings.maxRounds - used - 1), { timeoutMs: TOAST_MS })

  return blockReason(run)
}

async function report($: EngineInterface, settings: Settings): Promise<string> {
  const root = await $.session.root()

  return statusReport({
    settings,
    lock: await lockOf($, settings),
    check: await resolveCheck($, root, settings),
    root,
    hasChanges: await read($, hasChanges),
    lastRun: await read($, lastRun),
    now: await $.clock.now(),
  })
}

async function setLock($: EngineInterface, e: CommandRunInput, isLocked: boolean): Promise<{ text: string }> {
  if (!isLocked && !UNLOCKING_ORIGINS.has(e.origin.kind)) {
    return { text: '/unlock-tests runs only when you type it; it stays locked.' }
  }

  await update($, lockOverride, () => isLocked)

  return {
    text: isLocked
      ? 'done-gate: tests are locked for this session.'
      : 'done-gate: tests are unlocked for this session. /lock-tests locks them again.',
  }
}

async function registerCommands($: EngineInterface): Promise<void> {
  await $.command.register({ name: STATUS_COMMAND, description: 'Show the test lock, the check command and the last check run' })
  await $.command.register({ name: UNLOCK_COMMAND, description: 'Let Claude edit existing test files for the rest of this session' })
  await $.command.register({ name: LOCK_COMMAND, description: 'Lock existing test files again for this session' })
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options)

  on('session.start', async ($, e, next) => {
    await registerCommands($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const verdict = await guard($, e, settings)

    if (verdict.kind === 'deny') {
      return { deny: verdict.reason }
    }

    const result = await next(e)
    await noteChange($, e, result, verdict)

    return result
  })

  on('classic.Stop', async ($, e, next) => {
    const below = await next(e)

    // Another hook already sends the model back; one reason at a time, and no round spent.
    if (below.block !== undefined) {
      return below
    }

    const block = await gate($, e, settings)

    return block === null ? below : { ...below, block }
  })

  on('command.run', { command: STATUS_COMMAND }, async $ => ({ text: await report($, settings) }))
  on('command.run', { command: UNLOCK_COMMAND }, async ($, e) => setLock($, e, false))
  on('command.run', { command: LOCK_COMMAND }, async ($, e) => setLock($, e, true))
}
