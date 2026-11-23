/**
 * 응답 텍스트에서 이메일 주소 형태를 찾는 정규식. 마스킹(sender.ts)과 분류 입력 정리(classify.ts)가 공유한다.
 * 두 모듈이 서로 import하지 않도록 따로 둔다.
 *
 * 로컬 파트는 RFC 5321이 허용하는 작은따옴표(`o'brien@example.com`)를 중간에 가질 수 있다.
 * 첫 글자로는 허용하지 않는다. 주소를 작은따옴표로 감싼 경우(`'a@b.com'`)에 여는 따옴표까지 주소로 보지 않기 위해서다.
 * 도메인에서는 작은따옴표를 허용하지 않아 닫는 따옴표가 주소에 들어가지 않는다.
 */
export const EMAIL_LIKE = /[^\s<>"',;()[\]][^\s<>",;()[\]]*@[^\s<>"',;()[\]]+/g;

/**
 * 정규식에 넣기 전에 자르는 길이(문자). 이 정규식은 `@` 없이 길게 이어지는 입력에서 O(n²)로 백트래킹한다.
 * 최종 결과는 500자로 자르므로 앞 4 KiB만 봐도 결과는 같다. 잘라서 생긴 끝의 주소 조각이 남지 않게 끝부분의 마지막 공백까지만 쓴다.
 */
export const EMAIL_SCAN_LIMIT = 4096;

/** 이메일 주소 형태를 `replacement`로 바꾼다. 입력이 `EMAIL_SCAN_LIMIT`보다 길면 앞부분만 처리한다. */
export function maskEmailLike(text: string, replacement: string): string {
  let head = text;
  if (text.length > EMAIL_SCAN_LIMIT) {
    head = text.slice(0, EMAIL_SCAN_LIMIT);
    // 끝의 주소 조각을 버린다. 주소는 254자 이하이므로 끝 300자 안에서 마지막 공백을 찾는다. 없으면 그대로 둔다.
    const floor = head.length - 300;
    let cut = head.length - 1;
    while (cut > floor && !/\s/.test(head.charAt(cut))) cut--;
    if (cut > floor) head = head.slice(0, cut);
  }
  return head.replace(EMAIL_LIKE, replacement);
}
