/** 파일 채널 시작 검증 실패. 메시지는 변수 이름과 errno 코드만 담는다(RQ-027). main.ts가 이 메시지를 그대로 출력한다. */
export class FileChannelStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileChannelStartError";
  }
}
