-- 호출처별 24시간 rolling 발송 할당(RQ-032, ADR-0007 결정 10). 0001은 수정하지 않고 추가만 한다.
-- 시각은 DB now() 기준이다(ADR-0002 결정 10).

-- 할당 사용량을 mail_jobs 조인 없이 세기 위해 시도 행에 호출처를 복사한다.
-- NULL을 허용한다: 이 마이그레이션 전 버전의 인스턴스가 롤링 배포 중 caller_id 없이 쓴 행을 거부하지 않기 위해서다.
-- 그런 행은 사용량에 잡히지 않는다(단일 서비스 재기동 구간의 과소 계수, 문서에 기록).
ALTER TABLE mail_attempts ADD COLUMN caller_id text;
UPDATE mail_attempts a SET caller_id = j.caller_id FROM mail_jobs j WHERE j.id = a.job_id;

-- 사용량 = 최근 24시간의 "할당에 드는 시도" 수 + 현재 점유 중인 작업 수.
-- 할당에 드는 시도: 최대 시도 횟수에 포함되는(counted) 시도 중 Mailo 내부 오류(stage = 'WORKER')를 뺀 것.
-- 쿼리의 WHERE가 이 부분 인덱스 조건과 같아야 인덱스를 쓴다(claim.ts의 USAGE_SQL).
CREATE INDEX mail_attempts_quota_idx ON mail_attempts (caller_id, finished_at)
  WHERE counted AND stage IS DISTINCT FROM 'WORKER';

-- 점유 중인 작업 수(진행 중 시도는 아직 mail_attempts에 없다).
CREATE INDEX mail_jobs_sending_caller_idx ON mail_jobs (caller_id)
  WHERE status = 'SENDING';
