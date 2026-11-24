# Domain

- Glossary: [GLOSSARY.md](../../GLOSSARY.md), one for the repository.
- Design: [docs/SPEC.md](../SPEC.md); change it before changing direction.
- ADRs: none yet. A decision worth one goes in `docs/adr/`, numbered `0001-slug.md`.
- Compatibility: none kept (owner, 2026-11-24). screen-kit has no consumers to protect yet, so a change replaces the
  old recipe shape, option or output outright instead of carrying a legacy path beside it; its changelog entry says
  what was removed and what replaces it. This holds until the owner names a consumer to protect.
- Research notes: [docs/research](../research), one cited file per question, dated. Check a note's date before relying
  on it; tools in this field change monthly.
