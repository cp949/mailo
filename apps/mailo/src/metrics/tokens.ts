/** 앱이 공유하는 counter 저장소(`MetricsRegistry`)의 DI 토큰. 주입하지 않으면 증가는 무시된다(`noopMetrics`). */
export const APP_METRICS = Symbol("APP_METRICS");
