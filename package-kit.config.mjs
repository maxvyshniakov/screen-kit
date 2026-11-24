// The gate (bun run verify), the pre-push hook, the lane adapter (.githooks/lane-check), release and publish:
// @maxvyshniakov/package-kit (its README.md and docs/reference.md). Each test step reads what its test files reach in
// the code (scripts/step-inputs.mjs), so a lane check runs only the steps a change touches; a path no step owns and
// no INERT glob names runs the whole gate. docs/agents/checks.md, "Gate times", has the measured times.
import { TEST_GROUPS, testFile } from "./scripts/test-groups.mjs";
import { reachableInputs, repositoryRoot } from "./scripts/step-inputs.mjs";

const ROOT = repositoryRoot();
// Paths every step reads: a change to one runs the whole gate.
const FULL_RUN_INPUTS = ["package.json", "bun.lock", "scripts/run-tests.mjs"];
// Tracked paths no verify step reads.
export const INERT = [
  "LICENSE",
  ".gitignore",
  ".gitattributes",
  // Read by Lanefather and mastack's hooks, outside verify (docs/agents/orchestration.md).
  ".lanefather.toml",
  "docs/agents/hooks.json",
  // Prose; the changelog is the changelogs step's input.
  "**/*.md",
  // Dated research spikes kept as evidence beside their notes (docs/agents/domain.md); nothing runs them.
  "docs/research/**",
  // Rebuilds the bundled fonts by hand (fonts/README.md); the fonts themselves are test inputs.
  "tools/build-symbol-font.py",
];

export default {
  publish: {
    registry: "npm",
    access: "public",
  },
  packedConsumer: {
    types: false,
    probes: [
      ({ consumerDir, run, ok, fail }) => {
        const result = run("node_modules/.bin/screen-kit", ["--help"], { cwd: consumerDir });
        if (result.status === 0 && result.stdout.includes("screen-kit")) ok("node_modules/.bin/screen-kit runs");
        else fail(`node_modules/.bin/screen-kit --help exited ${result.status}:\n${result.stdout}${result.stderr}`);
      },
    ],
  },
  // A commit changing what the package ships adds a line under `## Unreleased`, or ends with `Changelog: none (<why>)`
  // (the commit-msg hook; AGENTS.md).
  changelog: { paths: ["src/**", "fonts/**", "package.json"] },
  verify: {
    // Captures, encoders and Remotion renders: two slots run two test groups side by side.
    slots: 2,
    // Tracked paths no step reads; any other path no step owns runs the whole gate (test/verify-steps.test.mjs).
    inert: INERT,
    // The gate's own configuration: a change to it runs its canaries, not the whole gate.
    runner: ["package-kit.config.mjs", "scripts/step-inputs.mjs", "scripts/test-groups.mjs"],
    canary: ["gate tests", "kit"],
    steps: ({ release }) => [
      {
        name: "changelogs",
        command: ["run", "check:changelogs", ...(release ? ["--", "--release"] : [])],
        cheap: true,
        memory: 0.1,
        inputs: ["CHANGELOG.md", ...FULL_RUN_INPUTS],
      },
      { name: "kit", command: ["run", "check:kit"], cheap: true, memory: 0.1, inputs: [".githooks/**", ".github/workflows/**", ...FULL_RUN_INPUTS] },
      {
        name: "lint",
        command: ["run", "lint"],
        cheap: true,
        always: true,
        memory: 0.3,
        inputs: ["src/**", "test/**", "tools/**", "scripts/**", "examples/**", ".oxlintrc.json", ...FULL_RUN_INPUTS],
      },
      ...Object.entries(TEST_GROUPS).map(([name, group]) => ({
        name,
        command: ["scripts/run-tests.mjs", name],
        // The cheap tier (changelogs, kit, lint, gate tests) passes before any of these starts. Four heavy groups side by
        // side starve Chromium of CPU until Remotion's page load times out: each holds a slot, two run at once under the
        // gate's two-slot lease, one at a time on a CI runner without Slotfather.
        memory: group.memory,
        ...(group.cheap && { cheap: true }),
        ...(group.heavy && { slots: 1 }),
        inputs: [...reachableInputs(ROOT, group.files.map(testFile)), ...FULL_RUN_INPUTS],
      })),
    ],
  },

};
