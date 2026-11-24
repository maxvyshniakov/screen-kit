# Publishing

## Branches

- Repository `maxvyshniakov/screen-kit`, public (owner-authorized 2026-11-05). Everyday destination: `dev`. `main`
  only for a release the owner asked for.
- package-kit's reference-transaction hook refuses local commits on `dev` and `main`: work on a lane
  ([orchestration](orchestration.md)).

## Gate

- The pre-push hook runs `bun run verify` on each pushed commit in a clean worktree, with the kit that commit pins
  ([checks](checks.md#full-gate)). Do not run it by hand just before a push: the hook does.

## Push

- `lanefather promote <sha>` takes the landing lock, pushes that exact commit to `dev` and moves the local branch.
- A release: `lanefather promote <release-sha> --ship` pushes it to `dev` and `main`, only with the owner's word.

## CI

- `.github/workflows/ci.yml` runs `bun run verify` on macOS and Linux for pushes to `dev` and `main` and for pull
  requests. Follow the pushed SHA's checks to their result: `gh run list -R maxvyshniakov/screen-kit --commit <sha>`.

## Release

- Owner's explicit authorization for each npm publish.
- Cut the version on a lane: `bun run release <patch|minor|major>` moves `## Unreleased` into the new version in
  `CHANGELOG.md` and sets `package.json`. Land, then `promote --ship`.
- Publish from CI: `gh workflow run release-npm.yml -R maxvyshniakov/screen-kit --ref main` (npm trusted publishing,
  OIDC, with provenance). Never `npm publish` from this Mac.

## Install

- Consumers pin an exact version. A local unpublished tarball may be vendored by a consumer with its source digest
  and archive hash.

## Report

- The pushed SHA, its CI result, and for a release the published version and the workflow run link.

## Media publishing and non-UI assets

- `screen-kit publish --target web` exports a local, self-contained web bundle (VP9/AV1 WebM, H.264 MP4, WebP poster,
  `embed.html`, and a `bundle.json` provenance manifest).
- `screen-kit publish --target youtube` is opt-in and never invoked by `capture`, `render` or `run`. `--dry-run`
  validates metadata, captions and thumbnail locally; a live upload needs the owner's explicit authorization and an
  OAuth token (`YOUTUBE_ACCESS_TOKEN`). The YouTube Data API v3 cannot upload extra audio-language tracks: add them in
  YouTube Studio.
- `screen-kit asset --kind thumbnail|wallpaper` (Imagen / Gemini Image API via `x-goog-api-key`) is opt-in, for non-UI
  assets only (stage wallpapers, YouTube thumbnails, covers), and never synthesizes UI frames.
