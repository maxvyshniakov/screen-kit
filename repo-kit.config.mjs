export default {
  verify: {
    steps: [
      { name: "kit", command: ["run", "check:kit"] },
      { name: "syntax", command: ["run", "check:syntax"] },
      { name: "test", command: ["run", "test"] },
    ],
  },
};
