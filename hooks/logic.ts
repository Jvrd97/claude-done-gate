import type { DoneGateRun } from '../types'

// ---------------------------------------------------------------- settings

export const DEFAULT_TEST_GLOBS: readonly string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/test_*.py',
  '**/*_test.py',
  '**/*_test.go',
  '**/tests/**',
  '**/__tests__/**',
  '**/spec/**',
]

const DEFAULT_TIMEOUT_SECONDS = 300
/** `$.process.run` refuses to wait longer than ten minutes. */
const MAX_TIMEOUT_SECONDS = 600
const DEFAULT_MAX_ROUNDS = 3
const MAX_ROUNDS_CAP = 20
const MS_PER_SECOND = 1000

export type Settings = {
  checkCommand: string
  timeoutMs: number
  maxRounds: number
  lockTests: boolean
  globs: readonly string[]
  isGateOn: boolean
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

const numberOr = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value)

  return Number.isFinite(parsed) ? parsed : fallback
}

/** Splits on commas outside `{...}`, so `*.{ts,js}` stays one glob. */
const splitTopLevel = (text: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let current = ''

  for (const char of text) {
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }

    depth += char === '{' ? 1 : char === '}' && depth > 0 ? -1 : 0
    current += char
  }

  return [...parts, current]
}

/** Test globs as the settings field spells them: comma-separated, empty means the defaults. */
export const parseGlobs = (text: string): readonly string[] => {
  const globs = splitTopLevel(text)
    .map(part => part.trim())
    .filter(part => part !== '')

  return globs.length === 0 ? DEFAULT_TEST_GLOBS : globs
}

export const settingsOf = (options: Readonly<Record<string, unknown>>): Settings => ({
  checkCommand: String(options.checkCommand ?? '').trim(),
  timeoutMs: clamp(numberOr(options.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS), 1, MAX_TIMEOUT_SECONDS) * MS_PER_SECOND,
  maxRounds: Math.floor(clamp(numberOr(options.maxRounds, DEFAULT_MAX_ROUNDS), 0, MAX_ROUNDS_CAP)),
  lockTests: options.lockTests !== false && options.lockTests !== 'false',
  globs: parseGlobs(String(options.testGlobs ?? '')),
  isGateOn: String(options.gate ?? 'on') !== 'off',
})

// ---------------------------------------------------------------- paths

/** Forward slashes, `.` and `..` folded; a leading `/` kept, a leading `..` of a relative path kept. */
export const normalizePath = (path: string): string => {
  const slashed = path.replace(/\\/g, '/')
  const isAbsolute = slashed.startsWith('/')
  const parts: string[] = []

  for (const part of slashed.split('/')) {
    if (part === '' || part === '.') {
      continue
    }

    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') {
      parts.pop()
      continue
    }

    if (part === '..' && isAbsolute) {
      continue
    }

    parts.push(part)
  }

  const joined = parts.join('/')

  return isAbsolute ? `/${joined}` : joined
}

/** A spelling the shell expands (`~`, `$HOME`) cannot be placed; it is matched as written. */
const isUnplaceable = (path: string): boolean => path.startsWith('~') || path.includes('$')

export const joinPath = (base: string, path: string): string =>
  path.startsWith('/') || isUnplaceable(path) ? normalizePath(path) : normalizePath(`${base}/${path}`)

/** The path relative to the root when it is under it; else the path without its leading slash. */
export const relativeTo = (root: string, path: string): string => {
  const normalized = normalizePath(path)
  const base = normalizePath(root).replace(/\/$/, '')

  if (normalized === base) {
    return ''
  }

  return normalized.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : normalized.replace(/^\/+/, '')
}

// ---------------------------------------------------------------- globs

const escapeRegExp = (text: string): string => text.replace(/[.+^$()|[\]\\{}*?]/g, '\\$&')

const globBody = (glob: string): string => {
  let out = ''
  let index = 0

  while (index < glob.length) {
    if (glob.startsWith('**/', index)) {
      out += '(?:.*/)?'
      index += 3
      continue
    }

    if (glob.startsWith('/**', index) && index + 3 === glob.length) {
      out += '(?:/.*)?'
      index += 3
      continue
    }

    if (glob.startsWith('**', index)) {
      out += '.*'
      index += 2
      continue
    }

    const char = glob.charAt(index)

    if (char === '*') {
      out += '[^/]*'
      index += 1
      continue
    }

    if (char === '?') {
      out += '[^/]'
      index += 1
      continue
    }

    const close = char === '{' ? glob.indexOf('}', index) : -1

    if (close > index) {
      out += `(?:${glob.slice(index + 1, close).split(',').map(globBody).join('|')})`
      index = close + 1
      continue
    }

    out += escapeRegExp(char)
    index += 1
  }

  return out
}

/** `**` crosses folders, `*` and `?` stay inside one, `{a,b}` is either; a trailing `/**` also matches the folder itself. */
export const globToRegExp = (glob: string): RegExp => new RegExp(`^${globBody(normalizePath(glob))}$`)

export const matchersOf = (globs: readonly string[]): readonly RegExp[] => globs.map(globToRegExp)

/** Whether a path relative to the project root is a test file (or a test folder) under the globs. */
export const isTestPath = (relative: string, matchers: readonly RegExp[]): boolean => {
  const path = normalizePath(relative)

  return path !== '' && matchers.some(matcher => matcher.test(path))
}

/** A spelling the shell would expand into many files: it cannot be checked for existence, only matched. */
export const hasWildcard = (path: string): boolean => /[*?[]/.test(path)

// ---------------------------------------------------------------- shell

type Token = { kind: 'word'; text: string } | { kind: 'op'; text: string }

const SEPARATORS = new Set([';', '&&', '||', '|', '&', '\n'])
const WORD_END = /[\s;&|<>()]/

/** Skips the bodies of the here-documents opened on the line just ended; returns where the next line starts. */
const skipHeredocs = (command: string, start: number, delimiters: readonly string[]): number => {
  let index = start

  for (const delimiter of delimiters) {
    while (index < command.length) {
      const end = command.indexOf('\n', index)
      const line = command.slice(index, end < 0 ? command.length : end)
      index = end < 0 ? command.length : end + 1

      if (line.trim() === delimiter) {
        break
      }
    }
  }

  return index
}

/** Reads a here-document's delimiter word after `<<` / `<<-`, quotes dropped. */
const readDelimiter = (command: string, start: number): { delimiter: string; end: number } => {
  let index = start

  while (command.charAt(index) === ' ' || command.charAt(index) === '\t') {
    index += 1
  }

  let delimiter = ''

  while (index < command.length && !WORD_END.test(command.charAt(index))) {
    const char = command.charAt(index)

    if (char !== '"' && char !== "'" && char !== '\\') {
      delimiter += char
    }

    index += 1
  }

  return { delimiter, end: index }
}

/**
 * A shell command as words and operators: quotes and escapes resolved,
 * comments and here-document bodies dropped, `>` and `>>` (with or without an
 * fd) one `>` operator, an fd duplication (`2>&1`) nothing, and a subshell or
 * command substitution read as a separator. Enough to see what a command
 * writes, not a shell.
 */
export const lexShell = (command: string): Token[] => {
  const tokens: Token[] = []
  let word = ''
  let hasWord = false
  let heredocs: string[] = []
  let index = 0

  const flush = (): void => {
    if (hasWord) {
      tokens.push({ kind: 'word', text: word })
    }

    word = ''
    hasWord = false
  }

  const op = (text: string): void => {
    flush()
    tokens.push({ kind: 'op', text })
  }

  while (index < command.length) {
    const char = command.charAt(index)
    const following = command.charAt(index + 1)

    if (char === '\\') {
      if (following !== '\n') {
        word += following
        hasWord = true
      }

      index += 2
      continue
    }

    if (char === "'") {
      const close = command.indexOf("'", index + 1)
      const end = close < 0 ? command.length : close
      word += command.slice(index + 1, end)
      hasWord = true
      index = end + 1
      continue
    }

    if (char === '"') {
      let cursor = index + 1

      while (cursor < command.length && command.charAt(cursor) !== '"') {
        if (command.charAt(cursor) === '\\' && cursor + 1 < command.length) {
          cursor += 1
        }

        word += command.charAt(cursor)
        cursor += 1
      }

      hasWord = true
      index = cursor + 1
      continue
    }

    if (char === '#' && !hasWord) {
      const end = command.indexOf('\n', index)
      index = end < 0 ? command.length : end
      continue
    }

    if (char === ' ' || char === '\t') {
      flush()
      index += 1
      continue
    }

    if (char === '\n') {
      op('\n')
      index = heredocs.length > 0 ? skipHeredocs(command, index + 1, heredocs) : index + 1
      heredocs = []
      continue
    }

    if (char === ';' || char === '(' || char === ')' || char === '`') {
      op(';')
      index += 1
      continue
    }

    if (char === '$' && following === '(') {
      op(';')
      index += 2
      continue
    }

    if (char === '|') {
      op(following === '|' ? '||' : '|')
      index += following === '|' || following === '&' ? 2 : 1
      continue
    }

    if (char === '&' && following === '&') {
      op('&&')
      index += 2
      continue
    }

    if (char === '&' && following === '>') {
      op('>')
      index += command.charAt(index + 2) === '>' ? 3 : 2
      continue
    }

    if (char === '&') {
      op('&')
      index += 1
      continue
    }

    if (char === '>') {
      if (hasWord && /^\d+$/.test(word)) {
        word = ''
        hasWord = false
      }

      let cursor = index + 1

      if (command.charAt(cursor) === '>' || command.charAt(cursor) === '|') {
        cursor += 1
      }

      if (command.charAt(cursor) === '&') {
        cursor += 1

        while (cursor < command.length && /[0-9-]/.test(command.charAt(cursor))) {
          cursor += 1
        }

        flush()
        index = cursor
        continue
      }

      op('>')
      index = cursor
      continue
    }

    if (char === '<') {
      if (following === '<' && command.charAt(index + 2) !== '<') {
        flush()
        const start = command.charAt(index + 2) === '-' ? index + 3 : index + 2
        const { delimiter, end } = readDelimiter(command, start)
        heredocs.push(delimiter)
        index = end
        continue
      }

      op('<')
      index += following === '<' ? 3 : 1
      continue
    }

    word += char
    hasWord = true
    index += 1
  }

  flush()

  return tokens
}

type Segment = { argv: string[]; writes: string[] }

const segmentsOf = (tokens: readonly Token[]): Segment[] => {
  const segments: Segment[] = []
  let current: Segment = { argv: [], writes: [] }
  let pending: '>' | '<' | null = null

  for (const token of tokens) {
    if (token.kind === 'op' && SEPARATORS.has(token.text)) {
      segments.push(current)
      current = { argv: [], writes: [] }
      pending = null
      continue
    }

    if (token.kind === 'op') {
      pending = token.text === '>' ? '>' : '<'
      continue
    }

    if (pending === '>') {
      current.writes.push(token.text)
    } else if (pending === null) {
      current.argv.push(token.text)
    }

    pending = null
  }

  segments.push(current)

  return segments.filter(segment => segment.argv.length > 0 || segment.writes.length > 0)
}

/** Words that run the next word as the command: `sudo rm`, `if rm`, `xargs rm`. */
const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'exec', 'nohup', 'time', 'env', 'xargs', 'nice', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

const commandOf = (argv: readonly string[]): string[] => {
  let start = 0

  while (start < argv.length) {
    const word = argv[start] ?? ''

    if (ASSIGNMENT.test(word)) {
      start += 1
      continue
    }

    if (!WRAPPERS.has(word)) {
      break
    }

    start += 1

    while (start < argv.length && (argv[start] ?? '').startsWith('-')) {
      start += 1
    }
  }

  return argv.slice(start)
}

/** The words that are not options, skipping the value after each flag in `valueFlags`; all after `--`. */
const operandsOf = (args: readonly string[], valueFlags: ReadonlySet<string> = new Set()): string[] => {
  const operands: string[] = []
  let isRaw = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''

    if (isRaw || !arg.startsWith('-') || arg === '-') {
      operands.push(arg)
      continue
    }

    if (arg === '--') {
      isRaw = true
      continue
    }

    if (valueFlags.has(arg)) {
      index += 1
    }
  }

  return operands
}

const baseName = (word: string): string => word.slice(word.lastIndexOf('/') + 1)

const REMOVERS = new Set(['rm', 'unlink', 'rmdir', 'shred', 'trash'])
const WRITERS_LAST = new Set(['cp', 'install', 'ln'])
const WRITERS_ALL = new Set(['tee', 'truncate'])
const OTHER_WRITERS = new Set(['touch', 'mkdir', 'patch', 'dd', 'black', 'isort', 'rustfmt', 'autopep8'])
const GIT_WRITES = new Set(['apply', 'am', 'checkout', 'cherry-pick', 'clean', 'merge', 'mv', 'pull', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch'])
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree'])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'uv', 'poetry', 'cargo', 'go'])
const PACKAGE_WRITES = new Set([
  'install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'ci', 'link', 'unlink',
  'sync', 'lock', 'fmt', 'fix', 'get', 'mod', 'generate', 'init', 'new',
])
/** The flags that make each interpreter run code given inline, which may write anything. */
const INLINE_CODE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  python: ['-c'],
  python3: ['-c'],
  node: ['-e', '--eval', '-p', '--print'],
  bun: ['-e', '--eval'],
  deno: ['eval'],
  ruby: ['-e'],
  perl: ['-e', '-E'],
}
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])
const FIX_FLAGS = new Set(['--write', '--fix', '--fix-only'])
const SED_VALUE_FLAGS = new Set(['-e', '-f', '--expression', '--file', '-l'])
const PERL_VALUE_FLAGS = new Set(['-e', '-E', '-M', '-m', '-I'])
const DEVICE = /^\/dev\//

export type ShellTarget = { kind: 'remove' | 'write'; path: string }
export type ShellEffects = { targets: ShellTarget[]; isWrite: boolean }

const isInPlace = (args: readonly string[]): boolean =>
  args.some(arg => /^-[A-Za-z]*i/.test(arg) || arg.startsWith('--in-place'))

/** What one simple command removes and writes, and whether it may change files at all. */
const effectsOf = (argv: readonly string[]): ShellEffects => {
  const [head = '', ...args] = commandOf(argv)
  const name = baseName(head)
  const operands = operandsOf(args)
  const removes = (paths: readonly string[]): ShellTarget[] => paths.map(path => ({ kind: 'remove', path }))
  const writes = (paths: readonly string[]): ShellTarget[] => paths.map(path => ({ kind: 'write', path }))
  const last = operands.length >= 2 ? operands.slice(-1) : []

  if (REMOVERS.has(name)) {
    return { targets: removes(operands), isWrite: true }
  }

  if (name === 'mv') {
    return { targets: [...removes(operands.length >= 2 ? operands.slice(0, -1) : operands), ...writes(last)], isWrite: true }
  }

  if (WRITERS_LAST.has(name)) {
    return { targets: writes(last), isWrite: true }
  }

  if (WRITERS_ALL.has(name)) {
    return { targets: writes(operands), isWrite: true }
  }

  if (name === 'dd') {
    return { targets: writes(args.filter(arg => arg.startsWith('of=')).map(arg => arg.slice('of='.length))), isWrite: true }
  }

  if (OTHER_WRITERS.has(name)) {
    return { targets: [], isWrite: true }
  }

  if (name === 'sed' && isInPlace(args)) {
    const hasScriptFlag = args.some(arg => SED_VALUE_FLAGS.has(arg))
    // BSD sed takes the backup suffix as its own word (`-i ''`); an empty word is never a file.
    const files = operandsOf(args, SED_VALUE_FLAGS).filter(file => file !== '')

    return { targets: writes(hasScriptFlag ? files : files.slice(1)), isWrite: true }
  }

  if (name === 'perl' && isInPlace(args)) {
    return { targets: writes(operandsOf(args, PERL_VALUE_FLAGS)), isWrite: true }
  }

  if (name === 'git') {
    const [sub = '', ...rest] = operandsOf(args, GIT_VALUE_FLAGS)
    const subArgs = args.slice(args.indexOf(sub) + 1)
    const subOperands = operandsOf(subArgs)

    if (sub === 'rm') {
      return { targets: removes(rest.length > 0 ? subOperands : []), isWrite: true }
    }

    if (sub === 'mv') {
      return effectsOf(['mv', ...subArgs])
    }

    return { targets: [], isWrite: GIT_WRITES.has(sub) }
  }

  if (PACKAGE_MANAGERS.has(name)) {
    const sub = operands[0]

    return { targets: [], isWrite: (name === 'yarn' && sub === undefined) || (sub !== undefined && PACKAGE_WRITES.has(sub)) }
  }

  const script = SHELLS.has(name) ? args[args.indexOf('-c') + 1] : undefined

  if (args.includes('-c') && script !== undefined) {
    return shellEffects(script, '.')
  }

  if ((INLINE_CODE_FLAGS[name] ?? []).some(flag => args.includes(flag))) {
    return { targets: [], isWrite: true }
  }

  return { targets: [], isWrite: (name === 'gofmt' && args.includes('-w')) || args.some(arg => FIX_FLAGS.has(arg)) }
}

/**
 * What a Bash command may remove or write, paths resolved against the root
 * (and against a `cd` earlier in the same command), and whether it looks like
 * a write at all. Best effort: a script the command runs, `find -delete` or
 * `xargs rm` hide their targets.
 */
export const shellEffects = (command: string, root: string): ShellEffects => {
  const targets: ShellTarget[] = []
  let isWrite = false
  let base = root

  for (const segment of segmentsOf(lexShell(command))) {
    const [head = '', ...args] = commandOf(segment.argv)

    if (head === 'cd' || head === 'pushd') {
      const to = args.find(arg => !arg.startsWith('-'))
      base = to === undefined || isUnplaceable(to) ? root : joinPath(base, to)
      continue
    }

    for (const path of segment.writes) {
      if (!DEVICE.test(path)) {
        targets.push({ kind: 'write', path: joinPath(base, path) })
        isWrite = true
      }
    }

    const effects = effectsOf(segment.argv)
    isWrite ||= effects.isWrite

    for (const target of effects.targets) {
      targets.push({ kind: target.kind, path: joinPath(base, target.path) })
    }
  }

  return { targets, isWrite }
}

// ---------------------------------------------------------------- check command

export const PROBE_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'pyproject.toml',
  'pytest.ini',
  'setup.cfg',
  'uv.lock',
  'Cargo.toml',
  'go.mod',
] as const

export type ProbeFile = (typeof PROBE_FILES)[number]

export type ProjectProbe = { present: ReadonlySet<ProbeFile>; packageJson: string | null }

export type CheckSource = 'setting' | 'package.json' | 'pytest' | 'cargo' | 'go'

export type CheckCommand = { command: string; source: CheckSource }

/** `npm init` writes this placeholder; it fails by design and tests nothing. */
const NPM_PLACEHOLDER = 'no test specified'
/** pytest's exit code when it collected no tests: nothing failed. */
export const PYTEST_NO_TESTS = 5

const testScriptOf = (packageJson: string | null): string | null => {
  if (packageJson === null) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(packageJson)

    if (typeof parsed !== 'object' || parsed === null || !('scripts' in parsed)) {
      return null
    }

    const { scripts } = parsed

    if (typeof scripts !== 'object' || scripts === null || !('test' in scripts)) {
      return null
    }

    const { test } = scripts

    return typeof test === 'string' && test.trim() !== '' && !test.includes(NPM_PLACEHOLDER) ? test : null
  } catch {
    return null
  }
}

const nodeRunner = (present: ReadonlySet<ProbeFile>): string => {
  if (present.has('pnpm-lock.yaml')) {
    return 'pnpm test'
  }

  if (present.has('yarn.lock')) {
    return 'yarn test'
  }

  // `bun test` is bun's own test runner; `bun run test` is the script.
  if (present.has('bun.lockb') || present.has('bun.lock')) {
    return 'bun run test'
  }

  return 'npm test'
}

/** The project's test command from the files at its root, or null when nothing says how to test it. */
export const detectCommand = (probe: ProjectProbe): CheckCommand | null => {
  const { present } = probe

  if (present.has('package.json') && testScriptOf(probe.packageJson) !== null) {
    return { command: nodeRunner(present), source: 'package.json' }
  }

  if (present.has('pyproject.toml') || present.has('pytest.ini') || present.has('setup.cfg')) {
    return { command: present.has('uv.lock') ? 'uv run pytest -q' : 'pytest -q', source: 'pytest' }
  }

  if (present.has('Cargo.toml')) {
    return { command: 'cargo test', source: 'cargo' }
  }

  if (present.has('go.mod')) {
    return { command: 'go test ./...', source: 'go' }
  }

  return null
}

export const isPassing = (exitCode: number | null, check: CheckCommand): boolean =>
  exitCode === 0 || (check.source === 'pytest' && exitCode === PYTEST_NO_TESTS)

// ---------------------------------------------------------------- output

export const TAIL_LINES = 40
const MAX_LINE_CHARS = 400
const SECONDS_PER_MINUTE = 60
const TENTHS_UNDER_SECONDS = 10

/** Color and cursor codes (CSI) and terminal titles and links (OSC), which a test runner prints to a TTY-less pipe anyway. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g

const cleanStream = (text: string): string =>
  text
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd()

/** The last lines of what the check printed, stdout then stderr, colors and progress redraws removed. */
export const tailOf = (stdout: string, stderr: string, lines = TAIL_LINES): string =>
  [cleanStream(stdout), cleanStream(stderr)]
    .filter(text => text !== '')
    .join('\n')
    .split('\n')
    .slice(-lines)
    .map(line => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line))
    .join('\n')

export const formatDuration = (ms: number): string => {
  const seconds = ms / MS_PER_SECOND

  if (seconds < TENTHS_UNDER_SECONDS) {
    return `${seconds.toFixed(1)}s`
  }

  if (seconds < SECONDS_PER_MINUTE) {
    return `${Math.round(seconds)}s`
  }

  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE)
  const rest = Math.round(seconds % SECONDS_PER_MINUTE)

  return `${minutes}m ${String(rest).padStart(2, '0')}s`
}

const exitText = (run: DoneGateRun): string => (run.exitCode === null ? 'did not finish' : `exit ${run.exitCode}`)

export const LOCK_REASON = 'Tests are locked. If a test is wrong, say which one and why; the user can run /unlock-tests.'

export const denyReason = (action: string, relative: string): string => `${LOCK_REASON} (Blocked: ${action} ${relative})`

/** What the model reads when the gate sends it back. */
export const blockReason = (run: DoneGateRun): string =>
  [
    `done-gate: the checks fail, so the work is not done. \`${run.command}\` ended with ${exitText(run)} after ${formatDuration(run.durationMs)}.`,
    `Last ${TAIL_LINES} lines of output:`,
    '```',
    run.tail === '' ? '(no output)' : run.tail,
    '```',
    "Fix the code, not the tests, before saying it's done. If a test itself is wrong, stop and say which one and why.",
  ].join('\n')

export const passToast = (run: DoneGateRun): string => `done-gate: checks passed in ${formatDuration(run.durationMs)}`

export const failToast = (run: DoneGateRun, roundsLeft: number): string =>
  `done-gate: checks failed (${exitText(run)}): ${roundsLeft} ${roundsLeft === 1 ? 'round' : 'rounds'} left`

export const giveUpToast = (rounds: number): string =>
  `done-gate: checks still failing after ${rounds} ${rounds === 1 ? 'round' : 'rounds'}`

export const NO_COMMAND_TOAST = 'done-gate: no test command found (package.json, pyproject.toml, Cargo.toml, go.mod); set checkCommand to turn the gate on'

export type LockState = { isLocked: boolean; isOverridden: boolean }

export type StatusInput = {
  settings: Settings
  lock: LockState
  check: CheckCommand | null
  root: string
  hasChanges: boolean
  lastRun: DoneGateRun | null
  now: number
}

const lockLine = (lock: LockState): string => {
  if (lock.isOverridden) {
    return lock.isLocked ? 'locked for this session (/lock-tests)' : 'unlocked for this session (/unlock-tests)'
  }

  return lock.isLocked ? 'locked (lockTests setting)' : 'unlocked (lockTests setting)'
}

const agoText = (ms: number): string => (ms < MS_PER_SECOND ? 'just now' : `${formatDuration(ms)} ago`)

/** What /done-gate prints. */
export const statusReport = (input: StatusInput): string => {
  const { settings, lock, check, lastRun } = input
  const lines = [
    `tests: ${lockLine(lock)}`,
    `test globs: ${settings.globs.join(', ')}`,
    `gate: ${settings.isGateOn ? `on, up to ${settings.maxRounds} rounds, timeout ${formatDuration(settings.timeoutMs)}` : 'off'}`,
    check === null
      ? `check command: none found in ${input.root}; set checkCommand`
      : `check command: ${check.command} (${check.source === 'setting' ? 'checkCommand setting' : `detected: ${check.source}`})`,
    `files changed since the last check: ${input.hasChanges ? 'yes' : 'no'}`,
  ]

  if (lastRun === null) {
    lines.push('last run: none this session')
  } else {
    lines.push(
      `last run: ${new Date(lastRun.at).toISOString()} (${agoText(input.now - lastRun.at)}), ${exitText(lastRun)}, ${formatDuration(lastRun.durationMs)}, ${lastRun.isPassed ? 'passed' : 'failed'}`,
      lastRun.tail === '' ? '(no output)' : lastRun.tail,
    )
  }

  return lines.join('\n')
}
