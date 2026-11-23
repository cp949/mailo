// NFS 환경이 필요하다. `scripts/nfs/run.sh`가 환경을 만들고 이 설정으로 실행한 뒤 정리한다.
// 환경이 없으면 테스트는 건너뛴다. `MAILO_NFS_REQUIRED=1`이면 건너뛰지 않고 실패한다(CI).
// 통합 테스트(`pnpm test:integration`)와 PostgreSQL이 필요하다는 점은 같다.
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
  testRegex: "test/nfs/.*\\.nfs-spec\\.ts$",
  moduleFileExtensions: ["js", "json", "ts"],
  testTimeout: 180000,
};
