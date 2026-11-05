# Checks

`slotfather run -n 1 -- bun run verify` runs repo-kit configuration, syntax and tests.
Focused tests: `slotfather run -n 1 -- node --test test/<name>.test.mjs`.
Terminal tests execute real PTY applications and verify screen expectations and cleanup.
Video tests encode and decode real files. Encoders and captures require one machine slot;
performance measurements require all slots.

Real browser acceptance: `slotfather run -n 1 -- env SCREEN_KIT_BROWSER_TESTS=1 node --test test/browser.test.mjs`.
The tests own a local fixture server and isolated browser sessions. Production browser
acceptance also includes all of the personal site's `config/screens.json` recipes, with
comparison artifacts retained outside the repository. P3 still verification checks actual
encoded primaries and ICC profiles, not just a metadata tag. P3 video is unverified.

Review checks fixture isolation, take provenance, process cleanup, source/version guards and
packed consumer parity. Consumers own import, pins and publication; capture alone does not
approve a changed picture or publish it.
