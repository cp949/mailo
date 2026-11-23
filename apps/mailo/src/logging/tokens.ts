/** 앱 전체가 공유하는 `AppLogger` DI 토큰. `createApp`이 만든 로거 하나를 Worker·파일 폴러가 받는다. */
export const APP_LOGGER = Symbol("APP_LOGGER");
