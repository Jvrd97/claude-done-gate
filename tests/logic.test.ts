import { describe, expect, test } from 'claude-code/testing'

import {
  blockReason,
  DEFAULT_TEST_GLOBS,
  detectCommand,
  formatDuration,
  isPassing,
  isTestPath,
  joinPath,
  lexShell,
  matchersOf,
  parseGlobs,
  relativeTo,
  settingsOf,
  shellEffects,
  statusReport,
  tailOf,
} from '../hooks/logic'
import type { ProbeFile } from '../hooks/logic'

const ROOT = '/work'
const DEFAULTS = matchersOf(DEFAULT_TEST_GLOBS)
const isTest = (path: string): boolean => isTestPath(path, DEFAULTS)

describe('test file globs', () => {
  test('common test file shapes match', () => {
    for (const path of [
      'src/app.test.ts',
      'app.test.js',
      'src/deep/nested/button.spec.tsx',
      'test_math.py',
      'pkg/tests/test_api.py',
      'pkg/math_test.py',
      'cmd/server/handler_test.go',
      'tests/fixtures/data.json',
      'tests',
      'src/components/__tests__/Button.tsx',
      'spec/models/user_spec.rb',
      'web/e2e/login.spec.ts',
    ]) {
      expect(isTest(path)).toBe(true)
    }
  })

  test('source files with test-like names do not match', () => {
    for (const path of [
      'src/app.ts',
      'src/latest.py',
      'src/contest.py',
      'src/testing/helpers.ts',
      'src/attest_test_helper.ts',
      'src/inspect/view.ts',
      'src/specs.md',
      'src/test.ts',
      'protests/notes.md',
      'README.md',
      'package.json',
      '',
    ]) {
      expect(isTest(path)).toBe(false)
    }
  })

  test('custom globs replace the defaults, braces and single stars work', () => {
    const custom = matchersOf(parseGlobs(' test/**, src/**/*.{check,verify}.ts ,'))

    expect(isTestPath('test/unit/a.js', custom)).toBe(true)
    expect(isTestPath('src/a/b/c.verify.ts', custom)).toBe(true)
    expect(isTestPath('src/a.test.ts', custom)).toBe(false)
    expect(isTestPath('lib/test/a.js', custom)).toBe(false)
  })

  test('an empty globs setting means the defaults', () => {
    expect(parseGlobs('')).toEqual(DEFAULT_TEST_GLOBS)
    expect(parseGlobs(' , ')).toEqual(DEFAULT_TEST_GLOBS)
  })

  test('paths resolve against the root, inside or outside it', () => {
    expect(relativeTo(ROOT, '/work/src/../tests/a.py')).toBe('tests/a.py')
    expect(relativeTo(ROOT, '/elsewhere/x.test.ts')).toBe('elsewhere/x.test.ts')
    expect(relativeTo(ROOT, '/work')).toBe('')
    expect(joinPath(ROOT, './src/a.ts')).toBe('/work/src/a.ts')
    expect(isTest(relativeTo(ROOT, '/work/../work/tests/a.py'))).toBe(true)
  })
})

describe('reading shell commands', () => {
  const targets = (command: string): string[] =>
    shellEffects(command, ROOT).targets.map(target => `${target.kind} ${relativeTo(ROOT, target.path)}`)

  test('removals and moves of files', () => {
    expect(targets('rm -f tests/test_a.py src/a.py')).toEqual(['remove tests/test_a.py', 'remove src/a.py'])
    expect(targets('git rm --cached src/a.test.ts')).toEqual(['remove src/a.test.ts'])
    expect(targets('mv src/a.test.ts /tmp/a')).toEqual(['remove src/a.test.ts', 'write tmp/a'])
    expect(targets('git mv old.spec.ts new.spec.ts')).toEqual(['remove old.spec.ts', 'write new.spec.ts'])
    expect(targets('sudo rm -rf -- __tests__')).toEqual(['remove __tests__'])
  })

  test('redirects, tee, cp, sed -i and dd write their targets', () => {
    expect(targets('echo ok > tests/test_a.py')).toEqual(['write tests/test_a.py'])
    expect(targets('printf x>>a.test.ts')).toEqual(['write a.test.ts'])
    expect(targets('cat x | tee -a b.spec.js')).toEqual(['write b.spec.js'])
    expect(targets('cp fixed.ts src/a.test.ts')).toEqual(['write src/a.test.ts'])
    expect(targets("sed -i '' 's/1/2/' a_test.go")).toEqual(['write a_test.go'])
    expect(targets("sed -i -e 's/1/2/' a_test.go b.go")).toEqual(['write a_test.go', 'write b.go'])
    expect(targets("perl -pi -e 's/a/b/' t/x.spec.ts")).toEqual(['write t/x.spec.ts'])
    expect(targets('dd if=/dev/zero of=tests/blob bs=1 count=1')).toEqual(['write tests/blob'])
  })

  test('cd inside the command moves the base for later parts', () => {
    expect(targets('cd pkg && rm math_test.py')).toEqual(['remove pkg/math_test.py'])
    expect(targets('cd pkg; cd ../other; echo > a.test.ts')).toEqual(['write other/a.test.ts'])
  })

  test('bash -c is read through', () => {
    expect(targets("bash -c 'cd tests && rm test_a.py'")).toEqual(['remove tests/test_a.py'])
  })

  test('quotes, fd redirects, here-documents and comments do not invent targets', () => {
    expect(targets('echo "a > tests/test_x.py"')).toEqual([])
    expect(targets('npm test 2>&1 | tail -n 40')).toEqual([])
    expect(targets('pytest -q > /dev/null 2>&1')).toEqual([])
    expect(targets("cat <<'EOF' > notes.md\nrm tests/test_a.py\n> tests/x\nEOF\necho done")).toEqual(['write notes.md'])
    expect(targets('ls tests # rm tests/test_a.py')).toEqual([])
    expect(targets('grep -rn "rm -rf" tests/')).toEqual([])
  })

  test('only write-like commands count as a change', () => {
    const writes = (command: string): boolean => shellEffects(command, ROOT).isWrite

    for (const command of ['ls -la', 'cat a.ts', 'git status', 'git diff HEAD', 'npm test', 'pytest -q', 'grep -w foo src', 'cargo test', 'go test ./...', 'echo hi', 'bash -e run.sh']) {
      expect(writes(command)).toBe(false)
    }

    for (const command of ['touch a', 'mkdir -p x', 'echo x > a.ts', 'npm install left-pad', 'yarn', 'uv add httpx', 'git checkout -- a.ts', 'python -c "open(1)"', 'npx prettier --write .', 'gofmt -w .', 'cp a b', 'git stash']) {
      expect(writes(command)).toBe(true)
    }
  })

  test('the lexer keeps words and operators apart', () => {
    expect(lexShell('a&&b || c;d|e &')).toEqual([
      { kind: 'word', text: 'a' },
      { kind: 'op', text: '&&' },
      { kind: 'word', text: 'b' },
      { kind: 'op', text: '||' },
      { kind: 'word', text: 'c' },
      { kind: 'op', text: ';' },
      { kind: 'word', text: 'd' },
      { kind: 'op', text: '|' },
      { kind: 'word', text: 'e' },
      { kind: 'op', text: '&' },
    ])
  })
})

describe('finding the check command', () => {
  const probe = (files: readonly ProbeFile[], packageJson: string | null = null) => ({ present: new Set(files), packageJson })
  const scripts = (test: string): string => JSON.stringify({ scripts: { test } })

  test('package.json with a test script, by lockfile', () => {
    expect(detectCommand(probe(['package.json'], scripts('vitest run')))?.command).toBe('npm test')
    expect(detectCommand(probe(['package.json', 'pnpm-lock.yaml'], scripts('vitest')))?.command).toBe('pnpm test')
    expect(detectCommand(probe(['package.json', 'yarn.lock'], scripts('jest')))?.command).toBe('yarn test')
    expect(detectCommand(probe(['package.json', 'bun.lock'], scripts('bun test')))?.command).toBe('bun run test')
  })

  test('the npm placeholder, a broken package.json or no script fall through', () => {
    const placeholder = scripts('echo "Error: no test specified" && exit 1')

    expect(detectCommand(probe(['package.json'], placeholder))).toBe(null)
    expect(detectCommand(probe(['package.json'], '{ not json'))).toBe(null)
    expect(detectCommand(probe(['package.json', 'pyproject.toml'], '{"name":"x"}'))?.command).toBe('pytest -q')
  })

  test('python, rust and go', () => {
    expect(detectCommand(probe(['pyproject.toml', 'uv.lock']))?.command).toBe('uv run pytest -q')
    expect(detectCommand(probe(['pytest.ini']))?.command).toBe('pytest -q')
    expect(detectCommand(probe(['setup.cfg']))?.command).toBe('pytest -q')
    expect(detectCommand(probe(['Cargo.toml']))?.command).toBe('cargo test')
    expect(detectCommand(probe(['go.mod']))?.command).toBe('go test ./...')
    expect(detectCommand(probe([]))).toBe(null)
  })

  test('pytest collecting nothing passes; any other non-zero fails', () => {
    expect(isPassing(5, { command: 'pytest -q', source: 'pytest' })).toBe(true)
    expect(isPassing(5, { command: 'make check', source: 'setting' })).toBe(false)
    expect(isPassing(0, { command: 'make check', source: 'setting' })).toBe(true)
    expect(isPassing(null, { command: 'cargo test', source: 'cargo' })).toBe(false)
  })
})

describe('settings and output', () => {
  test('defaults with zero config, clamps on junk', () => {
    expect(settingsOf({})).toEqual({
      checkCommand: '',
      timeoutMs: 300_000,
      maxRounds: 3,
      lockTests: true,
      globs: DEFAULT_TEST_GLOBS,
      isGateOn: true,
    })

    const odd = settingsOf({ timeoutSeconds: 99_999, maxRounds: -2, lockTests: false, gate: 'off', checkCommand: '  make check ' })

    expect(odd.timeoutMs).toBe(600_000)
    expect(odd.maxRounds).toBe(0)
    expect(odd.lockTests).toBe(false)
    expect(odd.isGateOn).toBe(false)
    expect(odd.checkCommand).toBe('make check')
  })

  test('the tail keeps the last lines, without colors or progress redraws', () => {
    const stdout = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n')
    const tail = tailOf(`${stdout}\n`, '\u001b[31mFAIL\u001b[0m  1 failed\r\n', 5)

    expect(tail).toBe('line 57\nline 58\nline 59\nline 60\nFAIL  1 failed')
    expect(tailOf('progress 10%\rprogress 100%\n', '')).toBe('progress 100%')
    expect(tailOf('\n> test\n> node sum.test.js\n', 'FAIL')).toBe('> test\n> node sum.test.js\nFAIL')
    expect(tailOf('', '')).toBe('')
  })

  test('durations', () => {
    expect(formatDuration(2_340)).toBe('2.3s')
    expect(formatDuration(12_400)).toBe('12s')
    expect(formatDuration(65_000)).toBe('1m 05s')
  })

  test('the block reason carries the command, the exit code, the tail and the instruction', () => {
    const reason = blockReason({ at: 0, command: 'npm test', exitCode: 1, durationMs: 1_200, isPassed: false, tail: 'AssertionError: 2 !== 3' })

    expect(reason).toContain('`npm test` ended with exit 1')
    expect(reason).toContain('AssertionError: 2 !== 3')
    expect(reason).toContain("Fix the code, not the tests, before saying it's done.")
  })

  test('the status report says when nothing ran yet', () => {
    const text = statusReport({
      settings: settingsOf({}),
      lock: { isLocked: true, isOverridden: false },
      check: null,
      root: ROOT,
      hasChanges: false,
      lastRun: null,
      now: 0,
    })

    expect(text).toContain('tests: locked (lockTests setting)')
    expect(text).toContain('check command: none found in /work')
    expect(text).toContain('last run: none this session')
  })
})
