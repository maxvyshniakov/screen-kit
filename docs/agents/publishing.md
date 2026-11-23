# Publishing

Repository: `maxvyshniakov/screen-kit`, public. Everyday destination: `dev`.
`main` is reserved for an explicitly requested release, following the other private
`@maxvyshniakov` repositories. Use Straylight’s `tools/lane promote <sha>` from this repository. It takes the
landing lock, pushes the explicit SHA to `dev`, and moves the local branch. The
package-kit reference hook protects local `main` and `dev`; commit on a task branch.

The package-kit pre-push hook runs `bun run verify` on the outgoing tree. Follow any
GitHub checks on the pushed SHA to their final result. The hosted GitHub Actions CI
workflow (`.github/workflows/ci.yml`) runs `bun run verify` on both macOS (`macos-latest`)
and Linux (`ubuntu-latest`) on pushes to `dev` and `main` and on pull requests.

Local unpublished tarballs may be vendored by consumers with source digest and archive
hash. Package registry publication and media uploads require separate explicit authorization.

## Media publishing & non-UI assets

- `screen-kit publish --target web` exports a local, self-contained web bundle (VP9/AV1 WebM,
  H.264 MP4, WebP poster, `embed.html`, and `bundle.json` provenance manifest).
- `screen-kit publish --target youtube` is strictly opt-in and never invoked implicitly by
  `capture`, `render`, or `run`. Use `--dry-run` to validate metadata, captions, and thumbnail
  locally; live uploads require explicit owner authorization and an OAuth token
  (`YOUTUBE_ACCESS_TOKEN`). Extra audio-language tracks cannot be uploaded through the YouTube
  Data API v3 and must be added manually in YouTube Studio.
- `screen-kit asset --kind thumbnail|wallpaper` is opt-in (Imagen / Gemini Image API via
  `x-goog-api-key`) for non-UI assets only (stage wallpapers, YouTube thumbnails, covers) and
  must never be used to synthesize UI frames.
