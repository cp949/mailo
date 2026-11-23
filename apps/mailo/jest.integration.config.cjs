// 실제 PostgreSQL이 필요하다. `docker compose up -d postgres` 뒤 실행한다.
// Testcontainers 대신 compose의 postgres를 쓴다. 의존성이 적고 로컬·CI에서 같은 방식이다.
/** @type {import('jest').Config} */
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: true, tsconfig: "tsconfig.test.json" }],
  },
  testRegex: "test/.*\\.integration-spec\\.ts$",
  moduleFileExtensions: ["js", "json", "ts"],
  testTimeout: 30000,
};
