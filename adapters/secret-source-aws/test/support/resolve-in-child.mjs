/**
 * 자식 프로세스에서 어댑터를 불러와(mode=load) 또는 해석하고(mode=resolve) 자연 종료한다.
 * `process.exit`를 부르지 않는다. 어댑터가 연결·타이머를 남기면 이 프로세스는 끝나지 않는다.
 * 출력은 값이 없는 표지뿐이다.
 */
const [mode, ref] = process.argv.slice(2);
const { default: source } = await import("../../index.js");

if (mode === "resolve") {
  try {
    await source.resolve(ref, { signal: new AbortController().signal });
    console.log("resolved");
  } catch (error) {
    console.log(`rejected:${error.code ?? "none"}`);
  }
} else {
  console.log(`loaded:${source.scheme}`);
}
