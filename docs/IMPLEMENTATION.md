# Implementation status

2026-11-05. The initial delivery created a private GitHub repository; the owner made it public on the same day. Registry publication and site media import remain separate actions.

Implemented:

- Browser screenshots: real input, explicit consumer preparation, readiness, URL/Storybook,
  catalog revisions, themes, crops, bands, composites and Display P3 preservation.
- Terminal capture: actual PTY, real keys/mouse, xterm screen assertions, complete process-group
  cleanup, reusable ANSI/input takes, PNG and animated lossless WebP.
- Browser recording and silent MP4/WebM export; saved terminal takes can be re-rendered without
  running their application. Measured output timing is recorded separately from requested timing.
- Capture manifests, source/recipe identity, take/artifact hashes, drift checks and review.
- Personal site migration: consumer-owned recipes, explicit preparation, local private package,
  immutable catalog sources, complete-run/import guards and site-owned media/pin integration.
- Slotfather navigation: historical queue, recorded workload metrics, active/waiting selection and moving history.
  Missing historical measurements are identified in the fixture rather than invented.

Acceptance evidence:

- Node tests drive real PTY input, validate navigation, verify failure reports and artifact
  tampering, replay casts without modifying them, and encode/decode actual video frames.
- Real browser tests cover delayed mount, actual input, crop/theme/ICC handling, preparation
  exactly once, intentionally opened content preservation and timed WebM recording.
- The website acceptance set is all 20 existing case recipes, including multi-theme and
  desktop/phone composite captures. Captures are temporary comparison artifacts, not imported.

## Independent review dispositions

The configured Anthropic reviewer was unavailable due to its weekly quota. Two blind passes
used separate fresh OpenAI contexts; reviewers did not edit files or run gates.

Spec pass (3 findings):

1. Sibling checkout dependency: fixed by a vendored private tarball and standalone install check.
2. Mutable current catalog stamped as a fixed revision: fixed by resolving then capturing the
   immutable release, with a real browser fixture regression.
3. Failed partial site capture importable: fixed by status/expected-selection evidence and
   complete-run guards before import.

Standards pass (6 findings, including the two catalog/report findings above):

1. Mutable catalog provenance: fixed as above.
2. TERM-ignoring descendant survives leader: reproduced and fixed with owned-group escalation;
   a real grandchild regression verifies cleanup.
3. Generic readiness changes consumer content: reproduced and fixed with explicit one-time
   consumer preparation; the opened-alert browser regression now passes.
4. Supported raw casts fail review: reproduced and fixed with asciicast structure/time checks;
   capture-to-review and tampered-event regressions cover it.
5. Out-of-order settle times can verify future content: reproduced and fixed by timestamp-order
   replay; the regression now rejects content absent at the asserted time.
6. Failed partial report: fixed as above.

One correction round was applied. No second reviewer pass was used to claim convergence.

## Subsequent edited-video work

Raw recording and reuse are available. The earlier video-first design's renderer-neutral
editing timeline, stage/camera composition, cursor/gesture overlays, captions and narration
remain a separate increment. Retina cadence and P3 video need explicit physical/encoded
acceptance. These are not represented as completed by screenshot or short-recording tests.
