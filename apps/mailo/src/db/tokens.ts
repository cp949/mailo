/** `pg.Pool` 주입 토큰. */
export const PG_POOL = Symbol("PG_POOL");
/** 앱이 풀을 만들었는지(true) 외부에서 받았는지(false). 만든 쪽만 종료 때 닫는다. */
export const POOL_OWNED = Symbol("POOL_OWNED");
