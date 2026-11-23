import { hostname } from "node:os";
import type { EnvReader } from "./env-reader.js";

const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 로그 줄의 `instance` 값(M10). `MAILO_INSTANCE_ID`가 있으면 그 값, 없으면 호스트 이름(컨테이너에서는 컨테이너 ID)이다.
 * 로그 줄마다 들어가므로 길이와 문자를 제한한다(영문·숫자·`.`·`_`·`-`, 최대 64자).
 */
export function loadInstanceId(reader: EnvReader): string {
  const value = reader.raw("MAILO_INSTANCE_ID");
  if (value === undefined) return hostname();
  if (!INSTANCE_ID.test(value))
    reader.issue(
      "MAILO_INSTANCE_ID는 영문·숫자로 시작하고 영문·숫자·`.`·`_`·`-`만 쓰는 64자 이하여야 한다",
    );
  return value;
}
