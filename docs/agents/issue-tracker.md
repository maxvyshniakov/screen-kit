# Issue tracker

- GitHub Issues of `maxvyshniakov/screen-kit`, in English. Pass the repository every time:
  `gh issue list -R maxvyshniakov/screen-kit`, `gh issue view <n> -R maxvyshniakov/screen-kit --comments`,
  `gh issue create -R maxvyshniakov/screen-kit --title ... --body-file ... --label ...`,
  `gh issue comment <n> -R maxvyshniakov/screen-kit --body-file ...`, `gh issue close <n> -R maxvyshniakov/screen-kit`.
- Labels: `bug`, `enhancement`, `documentation`, `accessibility` for the kind; `question` means waiting on the owner;
  `integrated` means landed on `dev`, not yet on `main` (Lanefather sets it after a green post-merge smoke).
- States: in progress is a claim comment naming the lane branch; blocked is a `Blocked by #N` line in the body.
- Titles: the area and the outcome in lower case (`terminal: draw takes in 24-bit colour`). Bodies: `**Problem.**`,
  `**Change.**`, `**Done when**`, and `**Order.**` when another ticket comes first.
- Reconciliation: a commit or landing merge that completes a ticket's whole scope ends with `Fixes #N`, so GitHub
  closes it when it reaches `main`; partial work says `Refs #N`. Lanefather comments the land and, after a release,
  the published version. Close by hand only completed scope, with the SHA on `main` in a comment.
