# Publishing

Repository: `maxvyshniakov/screen-kit`, public. Everyday destination: `dev`.
`main` is reserved for an explicitly requested release, following the other private
`@maxvyshniakov` repositories. Use Straylight’s `tools/lane promote <sha>` from this repository. It takes the
landing lock, pushes the explicit SHA to `dev`, and moves the local branch. The
repo-kit reference hook protects local `main` and `dev`; commit on a task branch.

The repo-kit pre-push hook runs `bun run verify` on the outgoing tree. Follow any
GitHub checks on the pushed SHA to their final result. The hosted GitHub Actions CI
workflow (`.github/workflows/ci.yml`) runs `bun run verify` on pushes to `dev` and
`main` and on pull requests.

Local unpublished tarballs may be vendored by consumers with source digest and archive
hash. Package registry publication and media uploads require separate explicit authorization.
