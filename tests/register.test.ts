import type { CommandRunInput, ProcessRunResult, SessionStartInput, ToolCallResult } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const ROOT = '/work'
const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: ROOT }
const NOW = Date.parse('2026-10-06T12:00:00Z')
const LOCKED = 'Tests are locked.'
const FAILING_TAIL = 'FAIL src/sum.test.ts\nexpected 3, received 2'

type TestOn = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

type Check = { exitCode: number; stdout?: string; stderr?: string } | 'timeout'

/** The engine beneath the plugin: files on disk, a check command's outcomes in order, and what the plugin showed. */
const world = (on: TestOn, files: Readonly<Record<string, string>>, checks: Check[] = []) => {
  const state = {
    files: new Map(Object.entries(files).map(([path, text]) => [`${ROOT}/${path}`, text])),
    toasts: [] as string[],
    runs: [] as { argv: readonly string[]; cwd: string | undefined; timeoutMs: number | undefined }[],
    tools: [] as string[],
    checks,
    /** What the settings hooks beneath the plugin answer at Stop. */
    stopBelow: {} as { block?: string },
  }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)

    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: state.files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = state.files.get(e.path)

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('process.run', ($, e) => {
    state.runs.push({ argv: e.argv, cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    const next = state.checks.shift() ?? { exitCode: 0 }

    if (next === 'timeout') {
      return { deny: 'timed out' }
    }

    const result: ProcessRunResult = {
      exitCode: next.exitCode,
      stdout: next.stdout ?? '',
      stderr: next.stderr ?? '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    }

    return { value: result }
  })
  on('tool.call', ($, e): ToolCallResult => {
    state.tools.push(e.tool)

    return e.tool === 'Bash' && /^(ls|cat|git status)\b/.test(e.command)
      ? { result: 'ok', text: 'ok', isReadOnly: true }
      : { result: 'ok', text: 'ok' }
  })
  on('classic.Stop', () => state.stopBelow)

  return state
}

const PACKAGE = { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) }
const PROJECT = { ...PACKAGE, 'src/sum.ts': 'export const sum = 1', 'src/sum.test.ts': 'test()' }

const command = (name: string, kind: 'composer' | 'sdk' | 'unclassified' = 'composer'): CommandRunInput => ({
  command: name,
  args: '',
  origin: { kind },
  presentation: { isFullscreen: false, columns: 120 },
})

const denied = (result: ToolCallResult): string => (result.isError === true || result.deny !== undefined ? String(result.text ?? result.deny) : '')

describe('the test lock', () => {
  test('editing an existing test file is denied with the reason', async ($, on) => {
    const state = world(on, PROJECT)
    await $.session.start(SESSION)

    const result = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/sum.test.ts`, old_string: '3', new_string: '2' })

    expect(denied(result)).toContain(LOCKED)
    expect(denied(result)).toContain('/unlock-tests')
    expect(denied(result)).toContain('src/sum.test.ts')
    expect(state.tools).toEqual([])
  })

  test('Write, MultiEdit and NotebookEdit on existing test files are denied too', async ($, on) => {
    world(on, { ...PROJECT, 'tests/test_api.py': 'x', 'tests/nb.ipynb': '{}' })
    await $.session.start(SESSION)

    expect(denied(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/tests/test_api.py`, content: 'pass' }))).toContain(LOCKED)
    expect(denied(await $.tool.call({ tool: 'MultiEdit', file_path: `${ROOT}/src/sum.test.ts`, edits: [] } as never))).toContain(LOCKED)
    expect(denied(await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${ROOT}/tests/nb.ipynb`, new_source: '' }))).toContain(LOCKED)
  })

  test('source files are not touched by the lock', async ($, on) => {
    const state = world(on, PROJECT)
    await $.session.start(SESSION)

    const result = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/sum.ts`, old_string: '1', new_string: '2' })

    expect(denied(result)).toBe('')
    expect(state.tools).toEqual(['Edit'])
  })

  test('a new test file may be created, and stays editable for the session', async ($, on) => {
    const state = world(on, PROJECT)
    await $.session.start(SESSION)

    const createdFile = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/new.test.ts`, content: 'test()' })
    state.files.set(`${ROOT}/src/new.test.ts`, 'test()')
    const edited = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/new.test.ts`, old_string: 'test', new_string: 'it' })

    expect(denied(createdFile)).toBe('')
    expect(denied(edited)).toBe('')
    expect(state.tools).toEqual(['Write', 'Edit'])
  })

  test('Bash rm, git rm, mv and redirects into existing test files are denied', async ($, on) => {
    const state = world(on, { ...PROJECT, 'tests/test_api.py': 'x' })
    await $.session.start(SESSION)

    for (const shell of ['rm src/sum.test.ts', 'git rm -q tests/test_api.py', 'mv src/sum.test.ts src/old.ts', 'echo "" > src/sum.test.ts', "sed -i 's/3/2/' src/sum.test.ts", 'cd tests && rm test_api.py', 'rm -rf tests']) {
      expect(denied(await $.tool.call({ tool: 'Bash', command: shell }))).toContain(LOCKED)
    }

    expect(state.tools).toEqual([])
  })

  test('safe shell commands pass, including writing a brand-new test file', async ($, on) => {
    const state = world(on, PROJECT)
    await $.session.start(SESSION)

    for (const shell of ['ls tests', 'cat src/sum.test.ts', 'npm test 2>&1 | tail -40', 'rm -f dist/out.js', 'echo "test()" > src/other.test.ts']) {
      expect(denied(await $.tool.call({ tool: 'Bash', command: shell }))).toBe('')
    }

    expect(state.tools.length).toBe(5)
  })

  test('/unlock-tests lifts the lock for the session and /lock-tests puts it back', async ($, on) => {
    world(on, PROJECT)
    await $.session.start(SESSION)

    const unlocked = await $.command.run(command('unlock-tests'))
    const edit = { tool: 'Edit' as const, file_path: `${ROOT}/src/sum.test.ts`, old_string: '3', new_string: '2' }

    expect(unlocked.text).toContain('unlocked')
    expect(denied(await $.tool.call(edit))).toBe('')

    await $.command.run(command('lock-tests'))

    expect(denied(await $.tool.call(edit))).toContain(LOCKED)
  })

  test('only the person can unlock: a command of unknown origin is refused', async ($, on) => {
    world(on, PROJECT)
    await $.session.start(SESSION)

    const answer = await $.command.run(command('unlock-tests', 'unclassified'))

    expect(answer.text).toContain('stays locked')
    expect(denied(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/sum.test.ts`, content: '' }))).toContain(LOCKED)
  })

  test('lockTests: false turns the lock off', { options: { lockTests: false } }, async ($, on) => {
    world(on, PROJECT)
    await $.session.start(SESSION)

    expect(denied(await $.tool.call({ tool: 'Bash', command: 'rm src/sum.test.ts' }))).toBe('')
  })

  test('custom globs decide what a test file is', { options: { testGlobs: 'checks/**' } }, async ($, on) => {
    world(on, { ...PROJECT, 'checks/a.sh': 'x' })
    await $.session.start(SESSION)

    expect(denied(await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/checks/a.sh`, old_string: 'x', new_string: 'y' }))).toContain(LOCKED)
    expect(denied(await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/sum.test.ts`, old_string: 'x', new_string: 'y' }))).toBe('')
  })
})

describe('the done gate', () => {
  const stop = { stop_hook_active: false, prompt_id: 'p1' }
  const again = { stop_hook_active: true, prompt_id: 'p1' }
  const edit = async ($: { tool: { call: (input: never) => Promise<ToolCallResult> } }) =>
    $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/sum.ts`, old_string: '1', new_string: '2' } as never)

  test('a turn that changed nothing stops without running checks', async ($, on) => {
    const state = world(on, PROJECT)
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/sum.ts` })

    expect((await $.classic.Stop(stop)).block).toBe(undefined)
    expect(state.runs).toEqual([])
  })

  test('passing checks let the model stop and toast the time', async ($, on) => {
    const state = world(on, PROJECT, [{ exitCode: 0, stdout: '1 passed' }])
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await edit($)

    expect((await $.classic.Stop(stop)).block).toBe(undefined)
    expect(state.runs).toEqual([{ argv: ['sh', '-c', 'npm test'], cwd: ROOT, timeoutMs: 300_000 }])
    expect(state.toasts).toEqual(['done-gate: checks passed in 0.0s'])
  })

  test('failing checks block with the exit code and the tail', async ($, on) => {
    const state = world(on, PROJECT, [{ exitCode: 1, stdout: 'running\n', stderr: FAILING_TAIL }])
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await edit($)

    const answer = await $.classic.Stop(stop)

    expect(answer.block).toContain('exit 1')
    expect(answer.block).toContain('expected 3, received 2')
    expect(answer.block).toContain("Fix the code, not the tests, before saying it's done.")
    expect(state.toasts).toEqual(['done-gate: checks failed (exit 1): 2 rounds left'])
  })

  test('a shell write counts as a change, a read-only command does not', async ($, on) => {
    const state = world(on, PROJECT, [{ exitCode: 1 }])
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'git status' })

    expect((await $.classic.Stop(stop)).block).toBe(undefined)

    await $.tool.call({ tool: 'Bash', command: "sed -i 's/1/2/' src/sum.ts" })

    expect((await $.classic.Stop({ ...stop, prompt_id: 'p2' })).block).toContain('exit 1')
    expect(state.runs.length).toBe(1)
  })

  test('after maxRounds the gate lets it stop and says checks still fail', { options: { maxRounds: 2 } }, async ($, on) => {
    const state = world(on, PROJECT, [{ exitCode: 1 }, { exitCode: 1 }, { exitCode: 1 }, { exitCode: 1 }])
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await edit($)

    expect((await $.classic.Stop(stop)).block).toContain('exit 1')
    expect((await $.classic.Stop(again)).block).toContain('exit 1')
    expect((await $.classic.Stop(again)).block).toBe(undefined)
    expect(state.toasts.at(-1)).toBe('done-gate: checks still failing after 2 rounds')
    expect(state.runs.length).toBe(3)

    // The released sequence cleared the change mark: nothing more runs until files change again.
    expect((await $.classic.Stop({ ...stop, prompt_id: 'p2' })).block).toBe(undefined)
    expect(state.runs.length).toBe(3)
  })

  test('a continuation never resets the count, even under a new prompt id', { options: { maxRounds: 1 } }, async ($, on) => {
    const state = world(on, PROJECT, [{ exitCode: 1 }, { exitCode: 1 }])
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await edit($)

    expect((await $.classic.Stop(stop)).block).toContain('exit 1')
    expect((await $.classic.Stop({ stop_hook_active: true, prompt_id: 'p9' })).block).toBe(undefined)
    expect(state.runs.length).toBe(2)
  })

  test('a timeout counts as a failure', { options: { timeoutSeconds: 5 } }, async ($, on) => {
    const state = world(on, PROJECT, ['timeout'])
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await edit($)

    const answer = await $.classic.Stop(stop)

    expect(answer.block).toContain('did not finish')
    expect(state.runs[0]?.timeoutMs).toBe(5_000)
  })

  test('checkCommand overrides detection', { options: { checkCommand: 'make check' } }, async ($, on) => {
    const state = world(on, PROJECT)
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await edit($)
    await $.classic.Stop(stop)

    expect(state.runs[0]?.argv).toEqual(['sh', '-c', 'make check'])
  })

  test('auto-detection reads the project root: uv + pytest', async ($, on) => {
    const state = world(on, { 'pyproject.toml': '[project]', 'uv.lock': '', 'app.py': '' })
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await edit($)
    await $.classic.Stop(stop)

    expect(state.runs[0]?.argv).toEqual(['sh', '-c', 'uv run pytest -q'])
  })

  test('with no test command the gate does nothing and says so once', async ($, on) => {
    const state = world(on, { 'main.c': '' })
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await edit($)
    await $.classic.Stop(stop)
    await edit($)
    await $.classic.Stop({ ...stop, prompt_id: 'p2' })

    expect(state.runs).toEqual([])
    expect(state.toasts.length).toBe(1)
    expect(state.toasts[0]).toContain('no test command found')
  })

  test('gate: off keeps the lock but never runs checks', { options: { gate: 'off' } }, async ($, on) => {
    const state = world(on, PROJECT, [{ exitCode: 1 }])
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await edit($)

    expect((await $.classic.Stop(stop)).block).toBe(undefined)
    expect(state.runs).toEqual([])
  })

  test('a block from beneath is passed on and spends no round', async ($, on) => {
    const state = world(on, PROJECT, [{ exitCode: 1 }])
    state.stopBelow = { block: 'another hook says no' }
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await edit($)

    expect((await $.classic.Stop(stop)).block).toBe('another hook says no')
    expect(state.runs).toEqual([])
  })

  test('/done-gate shows the lock, the command and the last run', async ($, on) => {
    world(on, PROJECT, [{ exitCode: 1, stderr: FAILING_TAIL }])
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await edit($)
    await $.classic.Stop(stop)
    await clock.advance(120_000)

    const text = (await $.command.run(command('done-gate'))).text ?? ''

    expect(text).toContain('tests: locked (lockTests setting)')
    expect(text).toContain('check command: npm test (detected: package.json)')
    expect(text).toContain('last run: 2026-10-06T12:00:00.000Z (2m 00s ago), exit 1')
    expect(text).toContain('expected 3, received 2')
  })
})
