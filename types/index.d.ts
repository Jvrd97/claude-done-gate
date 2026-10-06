export type DoneGateRun = {
  /** When the check finished, milliseconds since the epoch. */
  at: number
  command: string
  /** null when the check was killed by the timeout or could not start. */
  exitCode: number | null
  durationMs: number
  isPassed: boolean
  /** The last lines of stdout and stderr, ANSI codes stripped. */
  tail: string
}

declare module 'claude-code' {
  interface PluginState {
    'done-gate': {
      /** null follows the `lockTests` setting; /lock-tests and /unlock-tests override it for the session. */
      lockOverride: boolean | null
      /** Test files created in this session: they stay editable, so TDD works under the lock. */
      created: string[]
      /** Whether a tool call changed files since the gate last let the model stop. */
      hasChanges: boolean
      /** How many times the gate sent the model back since the prompt `promptId` names. */
      rounds: { promptId: string | null; count: number }
      lastRun: DoneGateRun | null
      /** Whether the "no check command found" note was shown this session. */
      hasSaidNoCommand: boolean
    }
  }
}
