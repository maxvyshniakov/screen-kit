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
  verify: {
    steps: ({ release }) => [
      { name: "changelogs", command: ["run", "check:changelogs", ...(release ? ["--", "--release"] : [])] },
      { name: "kit", command: ["run", "check:kit"] },
      { name: "syntax", command: ["run", "check:syntax"] },
      { name: "test", command: ["run", "test"] },
    ],
  },
};
