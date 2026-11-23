-- 작업 발송 우선순위(RQ-033·035·038, ADR-0009). 0001~0003은 수정하지 않고 추가만 한다.
-- 값은 등급별 순위다(LOW 10, NORMAL 20, HIGH 30, URGENT 40). 대응표는 `src/queue/priority.ts` 한 곳에 있다.
-- 등급 사이에 간격을 둔다. 나중에 등급을 끼워 넣어도 기존 행을 바꾸지 않기 위해서다.
--
-- 상수 DEFAULT 컬럼 추가는 PostgreSQL 11 이상에서 테이블을 다시 쓰지 않는다(문서 기준, 미측정).
-- 도입 전 작업은 DEFAULT로 NORMAL(20)이 된다.
ALTER TABLE mail_jobs ADD COLUMN priority smallint NOT NULL DEFAULT 20;

-- 허용 순위. NOT VALID라 기존 행을 훑지 않고 새 행·갱신 행에만 적용한다(0003과 같은 방식).
-- 기존 행은 모두 DEFAULT 20이라 어긋나는 행이 없고, 그래서 VALIDATE CONSTRAINT가 따로 필요 없다.
ALTER TABLE mail_jobs ADD CONSTRAINT mail_jobs_priority_rank
  CHECK (priority IN (10, 20, 30, 40)) NOT VALID;
