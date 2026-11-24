# screen-kit

Product screenshots, animations and recordings: consumer-owned recipes drive real browser
and terminal input; captures retain reusable takes and verification evidence. [docs/SPEC.md](docs/SPEC.md) is the design; change it before
changing direction.

- An agent must be able to run every step alone: write the script, record, render, review, fix
  and publish. Each capability gets a CLI or file interface and machine-checkable output before
  any UI is considered.
- The repository is public (owner-authorized 2026-11-05). Publishing a package to npm or
  uploading videos anywhere still needs the owner's explicit authorization.
- All code, docs and examples use English.
- Research notes, one cited file per question: [docs/research](docs/research). Check a note's
  date before relying on it; tools in this field change monthly.
- Facts per topic: [publishing](docs/agents/publishing.md), [checks](docs/agents/checks.md),
  [domain](docs/agents/domain.md), [issue tracker](docs/agents/issue-tracker.md),
  [orchestration](docs/agents/orchestration.md). Terms: [GLOSSARY.md](GLOSSARY.md).
- No backward compatibility yet: there are no consumers, so a changed interface replaces the old one outright, with
  no aliases or deprecation paths (owner, 2026-11-24).
- A commit that changes a shipped path (`changelog.paths` in `package-kit.config.mjs`) adds or changes a line under
  `## Unreleased` in `CHANGELOG.md`, in the same commit. When users cannot notice the change (tests, internal
  refactoring, tooling), end the message with the trailer `Changelog: none (<reason>)` instead. The commit-msg hook
  and `package-kit check-changelog-entries` enforce it.
- Engine behaviour on this Mac (Firefox, Safari Technology Preview, what no driver can reach):
  the `browser-verify` skill.
- Close every browser, driver, server and recorder you started as soon as the work no longer
  needs it.
