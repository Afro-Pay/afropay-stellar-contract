import http from "http";
import { URL } from "url";

export interface StreamResult {
  statusCode: number | undefined;
  text: string;
}

/**
 * Opens a raw HTTP connection to an SSE endpoint, accumulating response text
 * until `predicate` is satisfied (or `timeoutMs` elapses), then destroys the
 * socket. Used to drive real disconnect/reconnect scenarios against the
 * actual running API server — a full browser EventSource can't be told to
 * "drop the connection right now" from outside, but a raw socket can.
 */
export function streamUntil(
  url: string,
  headers: Record<string, string>,
  predicate: (text: string) => boolean,
  timeoutMs = 5000
): Promise<StreamResult> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    let text = "";
    let statusCode: number | undefined;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ statusCode, text });
    };

    const req = http.get(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        headers,
      },
      (res) => {
        statusCode = res.statusCode;
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          if (predicate(text)) finish();
        });
        res.on("close", finish);
        res.on("end", finish);
      }
    );

    req.on("error", finish);
    const timer = setTimeout(finish, timeoutMs);
  });
}

function fullEventReceived(text: string): boolean {
  return text.includes("data:") && text.trimEnd().endsWith("}");
}

export { fullEventReceived };
