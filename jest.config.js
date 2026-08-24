/** @type {import('jest').Config} */
const config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/__tests__"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          module: "commonjs",
          esModuleInterop: true,
          jsx: "react-jsx",
        },
      },
    ],
  },
  testMatch: [
    "**/__tests__/**/*.test.ts",
    "**/__tests__/**/*.test.tsx",
  ],
  setupFiles: ["<rootDir>/jest.setup.ts"],
  collectCoverageFrom: [
    "lib/**/*.ts",
    "components/**/*.tsx",
    "hooks/**/*.ts",
    "context/**/*.tsx",
    "app/**/*.tsx",
    "!lib/stellar/soroban.ts",
    "!lib/supabase/**",
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
};

module.exports = config;
