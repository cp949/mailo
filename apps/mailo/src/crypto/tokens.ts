/** 큐 모듈에 주입하는 본문 암호화기(`queue.BodyCipher` 모양). Worker가 복호화에도 쓴다. */
export const QUEUE_BODY_CIPHER = Symbol("QUEUE_BODY_CIPHER");
/** 큐 모듈에 주입하는 지문기(`queue.Fingerprinter` 모양). */
export const QUEUE_FINGERPRINTER = Symbol("QUEUE_FINGERPRINTER");
