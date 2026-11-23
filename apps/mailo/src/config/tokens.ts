/** 설정 주입 토큰. 모듈 경계 때문에 별도 파일에 둔다(순환 import 방지). */
export const APP_CONFIG = Symbol("APP_CONFIG");
/**
 * 설정을 읽은 환경 변수 맵. 호출처 JWS 비밀키와 JWE 개인키는 설정 파일 안의 변수 이름으로 가리키므로,
 * 해당 모듈이 같은 환경에서 값을 읽는다(시크릿 값은 설정 객체에 두지 않는다).
 */
export const APP_ENV = Symbol("APP_ENV");
