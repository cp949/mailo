/**
 * Secrets Manager 호환 로컬 HTTP fixture. `GetSecretValue` 요청만 받고 핸들러가 응답을 정한다.
 * 연결을 추적해 클라이언트가 연결을 닫았는지 본다.
 */
import { once } from "node:events";
import { createServer } from "node:http";

export async function startFixture(handler) {
  const requests = [];
  const connections = new Set();
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push({ target: request.headers["x-amz-target"], body });
    handler({ request, response, body, count: requests.length });
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    requests,
    openConnections: () => connections.size,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/** 성공 응답. */
export function sendSecret(response, secretString) {
  response.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
  response.end(JSON.stringify({ Name: "n", SecretString: secretString }));
}

/** AWS JSON 1.1 오류 응답. */
export function sendError(response, status, type, message) {
  response.writeHead(status, {
    "content-type": "application/x-amz-json-1.1",
    "x-amzn-errortype": type,
  });
  response.end(JSON.stringify({ __type: type, message }));
}

/** 조건이 참이 될 때까지 기다린다. 시간이 지나면 마지막 상태로 판정하게 두고 false를 돌려준다. */
export async function eventually(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
}
