module.exports = {
  testEnvironment: "node",
  testMatch: ["**/test/**/*.test.ts"],
  testEnvironmentOptions: { customExportConditions: ["node", "module-sync"] },
  setupFiles: ["<rootDir>/test/setup-env.cjs"],
  setupFilesAfterEnv: ["<rootDir>/test/setup-jest.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.test.json" }],
  },
};
