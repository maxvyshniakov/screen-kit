# Checks

## Focused
- None yet: the repository holds the design and research only.

## Full gate
- None yet. The first code adopts `@maxvyshniakov/repo-kit` (`bun run verify`, pre-push hook), set up
  like `inline-measure`.

## Heavy checks
- Every browser, recorder, renderer and encoder run goes through `slotfather run -n 1 -- <command>`;
  timing measurements take `-n all`.

## Browser and visual
- Engines and their limits: the `browser-verify` skill. Story screenshots for comparison:
  `repo-kit shoot` in Sid-Kit and Data Grid.

## Pins
- None.
