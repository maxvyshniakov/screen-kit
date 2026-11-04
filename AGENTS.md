# screen-kit

Agent-operated demo videos: a script is recorded in real browsers and rendered from a timeline,
and every render verifies itself. [docs/SPEC.md](docs/SPEC.md) is the design; change it before
changing direction.

- An agent must be able to run every step alone: write the script, record, render, review, fix
  and publish. Each capability gets a CLI or file interface and machine-checkable output before
  any UI is considered.
- The repository is private. Making it or a package public, publishing to npm, or uploading
  videos anywhere needs the owner's explicit authorization.
- All code, docs and examples use English.
- Research notes, one cited file per question: [docs/research](docs/research). Check a note's
  date before relying on it; tools in this field change monthly.
- Facts per topic: [docs/agents/publishing.md](docs/agents/publishing.md),
  [docs/agents/checks.md](docs/agents/checks.md), [docs/agents/domain.md](docs/agents/domain.md).
- Engine behaviour on this Mac (Firefox, Safari Technology Preview, what no driver can reach):
  the `browser-verify` skill.
- Close every browser, driver, server and recorder you started as soon as the work no longer
  needs it.
