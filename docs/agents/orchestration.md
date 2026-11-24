# Orchestration

Repository facts for `screen-kit`. General orchestration, review timing and fix rounds live in the `orchestrate` and
`cross-review` skills; Lanefather's commands are in its
[reference](https://github.com/maxvyshniakov/fathers/blob/main/lanefather/docs/reference.md), and how package-kit
plugs into it in package-kit's README ("Working with Lanefather").

## Lane tool

- Installed `lanefather`, configured by [.lanefather.toml](../../.lanefather.toml). Store
  `~/.local/state/lanefather/lanes`, shared with the other package-kit repositories; the queue is named
  "screen-kit engineering queue".
- Lane check: `.githooks/lane-check`, package-kit's adapter, written by `bunx package-kit hooks sync`. It runs the
  verify steps whose inputs the lane's diff touches ([checks](checks.md#full-gate)); the render and pipeline steps
  get a two-slot floor (`[checks.min_slots]`).
- Admission through Slotfather. Lanes live under `.claude/worktrees/lane-<id>` of the main checkout; run `bun install`
  in the main checkout once before the first lane.
- `dev` and `main` are guarded by package-kit's reference-transaction hook: work lands through `lanefather land` and
  reaches `origin/dev` through `lanefather promote <sha>` ([publishing](publishing.md)).
- `CHANGELOG.md` merges as a union (`.gitattributes`), so two lanes' `## Unreleased` entries both survive a landing.
  Read the merged section once after a land: a union keeps both lines, including two versions of the same one.

## Report labels

- Besides the skill's lines: `Lane: <lanefather id>` and `Receipt: <lanefather check receipt>`.

## Review

- Pre-land review is read-only and blind, against a `git archive` copy of the candidate commit.
- A change to what a take looks like (rendering, fonts, colours, timing) is reviewed with its pictures: before and
  after, from a scratch directory, never committed.
- One review round by default. A fix that adds a mechanism, touches the PTY driver's process cleanup, or exceeds ~80
  non-test lines gets a delta spot-check (`git diff <reviewed>..<fix>`).

## Owner queue

- Waiting on the owner: an issue labelled `question` ([issue tracker](issue-tracker.md)). Publishing to npm, uploads
  and pushes to `main` always wait for the owner's explicit word.

## Implementer brief (screen-kit)

- Work only in the assigned worktree and its claims.
- Focused checks while working ([checks](checks.md#focused)); `lanefather check <id>` before handing back. Do not wrap
  `lanefather check`, `land` or `promote` in `slotfather run --`; other heavy commands go through `slotfather run`
  with a label.
- A change a user would notice adds a line under `## Unreleased` in `CHANGELOG.md` in the same commit; otherwise end
  the message with `Changelog: none (<reason>)`.
- Captures for review go to a scratch directory and are named in the report by absolute path.
- Close every browser, driver, server and recorder you started.
