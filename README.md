# done-gate

A Claude Code mod that does not let Claude say "done" while your tests fail, and does not let it edit the tests to make them pass.

```
● Edit(src/sum.test.ts)
  ⎿  Error: Tests are locked. If a test is wrong, say which one and why; the user can run /unlock-tests. (Blocked: edit of src/sum.test.ts)

Stop hook feedback:
done-gate: the checks fail, so the work is not done. `npm test` ended with exit 1 after 0.1s.
Last 40 lines of output:
> node sum.test.js
FAIL sum(1, 2): expected 3, got -1
Fix the code, not the tests, before saying it's done. If a test itself is wrong, stop and say which one and why.

done-gate: checks failed (exit 1): 2 rounds left
done-gate: checks passed in 0.1s
```

## Why

Claude reports work as finished when it isn't: it says the tests pass without running them, rewrites or hardcodes tests until they go green, and leaves stubs behind.

- Reddit: [Playwright tests secretly patched the app to pass](https://www.reddit.com/r/ClaudeCode/comments/1rug14a/) (415 upvotes) and [Opus 5 imitates work instead of doing it](https://www.reddit.com/r/ClaudeCode/comments/1vhkxq9/).
- GitHub: [#83510](https://github.com/anthropics/claude-code/issues/83510) and [#42796](https://github.com/anthropics/claude-code/issues/42796).
- DoltHub: [Claude Code gotchas](https://www.dolthub.com/blog/2025-06-30-claude-code-gotchas/).

Existing tools: [nizos/tdd-guard](https://github.com/nizos/tdd-guard) enforces the TDD cycle only, and the built-in `/goal` sets what Claude works toward. done-gate does two plain things: it runs your tests whenever Claude wants to stop after changing files, and it keeps the existing tests out of Claude's reach.

## What it does

| Part | What |
|---|---|
| Test lock | Denies Edit, MultiEdit, Write and NotebookEdit on existing test files, and Bash `rm`, `git rm`, `mv`, redirects, `tee`, `cp`, `sed -i` and the like on them. Creating a new test file is allowed, and a test file created in this session stays editable, so TDD still works |
| Done gate | When Claude stops after a turn that changed files, it runs the check command. On failure Claude gets the exit code and the last 40 lines of output and keeps working, up to 3 rounds per prompt |
| Toasts | `checks passed in 12s`, `checks failed (exit 1): 2 rounds left`, `checks still failing after 3 rounds` |
| `/done-gate` | Lock state, test globs, the resolved check command, whether files changed since the last check, and the last run: time, exit code, duration and output tail |
| `/unlock-tests`, `/lock-tests` | Lift or restore the lock for the rest of the session |

The check command comes from the `checkCommand` setting, or from the project root:

| Found | Command |
|---|---|
| `package.json` with a `test` script | `npm test`; `pnpm test`, `yarn test` or `bun run test` when that lockfile is there |
| `pyproject.toml`, `pytest.ini` or `setup.cfg` | `pytest -q`, or `uv run pytest -q` with `uv.lock` |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| none of these | the gate does nothing and says so once per session |

The `npm init` placeholder script (`echo "Error: no test specified" && exit 1`) counts as no script, and pytest's "no tests collected" (exit 5) counts as a pass.

## Install

You need Claude Code with mods (function hooks). It was tested on 2.1.285.

From the marketplace in this repo:

```
/plugin marketplace add Jvrd97/claude-done-gate
/plugin install done-gate@done-gate
```

Or straight from disk, for one session:

```bash
git clone https://github.com/Jvrd97/claude-done-gate.git
claude --plugin-dir ./claude-done-gate
```

## Settings

Change them in `/config` under the plugin, or in `settings.json` under `pluginConfigs`:

| Field | Default | Meaning |
|---|---|---|
| `checkCommand` | empty | Shell command to run, e.g. `npm test && npm run typecheck`. Empty: detect from the project root |
| `timeoutSeconds` | `300` | A run that takes longer counts as failed. At most 600 |
| `maxRounds` | `3` | How many times per prompt the gate sends Claude back before it lets it stop anyway |
| `lockTests` | `true` | Lock existing test files |
| `testGlobs` | empty | Comma-separated globs relative to the project root; empty means `**/*.test.*`, `**/*.spec.*`, `**/test_*.py`, `**/*_test.py`, `**/*_test.go`, `**/tests/**`, `**/__tests__/**`, `**/spec/**` |
| `gate` | `on` | `off` keeps only the test lock |

## How it works

- `tool.call` sees every tool call before it runs. For an editing tool it resolves the path against the project root and matches it with the test globs; an existing test file is denied. For Bash it reads the command: quotes, `&&`, pipes, `cd`, redirects, here-documents and `bash -c` are understood, and every path the command removes or writes is checked the same way.
- After a call goes through, the mod marks the turn as changed when it was an editing tool, or a Bash command that looks like a write (redirect, `rm`, `mv`, `cp`, `sed -i`, `git checkout`, `npm install`, `python -c` and so on) and that Claude Code did not itself classify as read-only. `ls`, `cat`, `git status` or `npm test` do not count.
- `classic.Stop` fires when Claude wants to end its turn. With changes marked, the mod runs the check command with `sh -c` in the project root and answers `{ block }` on failure, which sends Claude back with the output. Rounds are counted per prompt (`prompt_id`); a continuation (`stop_hook_active`) never resets the count, so the gate cannot loop forever. A block from another Stop hook is passed on and costs no round.
- `/unlock-tests` only works when you type it (at the prompt, over Remote Control or as the prompt of `claude -p`), not when it arrives from a channel, a peer session or the model.
- State lives in the session (`$.state`): the lock override, the test files created this session, the change mark, the round count and the last run. The mod writes no files, sends nothing over the network and keeps nothing between sessions.

What it can't do:

- It cannot see what a script writes. `python fix.py`, `make`, `find -delete` or `xargs rm` may touch test files without the lock noticing, and such commands do not mark the turn as changed either.
- It does not protect the test setup itself. Claude could still change the `test` script in `package.json`, a `conftest.py` outside the globs, or the test runner config. Add those paths to `testGlobs` if you need them locked.
- `rm -rf src` is not denied even when `src` holds `__tests__`: the mod matches paths, it does not list folders.
- It runs your test command after every turn that changed files. A slow suite makes every such turn slower; point `checkCommand` at a fast subset.
- Test file detection is by name. A file named `*.spec.*` that is not a test is locked too, until you `/unlock-tests` or narrow `testGlobs`.
- The command runs through `sh`, so on Windows it needs a POSIX shell on `PATH`.

## Develop

Inside Claude Code run `/plugin-types .claude/types` once: it writes the API types `tsc` reads. Then:

```bash
tsc -p .
claude plugin validate .claude-plugin/plugin.json
claude plugin test .
```

## По-русски

Мод не даёт Claude сказать «готово», пока тесты падают, и не даёт ему переписать тесты, чтобы они позеленели.

- Когда Claude закончил ход и при этом менял файлы, мод запускает тесты проекта. Если они падают, Claude получает код выхода и последние 40 строк вывода и продолжает работу, до 3 раз на один запрос.
- Существующие тестовые файлы заблокированы: их нельзя править, удалять и перемещать, в том числе через Bash. Новые тесты создавать можно.
- `/unlock-tests` снимает блокировку до конца сессии, `/done-gate` показывает состояние и последний прогон.

Мод ничего не отправляет в сеть и не пишет файлы.

## License

MIT
