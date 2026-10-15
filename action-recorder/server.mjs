import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = process.env.SCREENHAND_RECORDER_HOST ?? "127.0.0.1";
const PORT = Number(process.env.SCREENHAND_RECORDER_PORT ?? 3017);
const UPSTREAM = new URL(
  process.env.SCREENHAND_RECORDER_UPSTREAM ?? "http://127.0.0.1:3013",
);
const PUBLIC_ROOT = fileURLToPath(new URL("./public/", import.meta.url));
const MAX_PROXY_BODY_BYTES = 256 * 1024;

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

if (
  UPSTREAM.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(UPSTREAM.hostname)
) {
  throw new Error("The ScreenHand upstream must be a loopback HTTP address.");
}
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  throw new Error("SCREENHAND_RECORDER_PORT must be a valid non-privileged port.");
}

export function allowedProxyRoute(method, pathname) {
  if (method === "GET" && pathname === "/api/v1/devices") return true;
  if (
    method === "GET" &&
    /^\/api\/v1\/devices\/[^/]+(?:\/actions(?:\/[^/]+)?)?$/.test(pathname)
  ) {
    return true;
  }
  return (
    method === "POST" &&
    /^\/api\/v1\/devices\/[^/]+\/actions$/.test(pathname)
  );
}

async function readRequestBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_PROXY_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function commonHeaders() {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    ...commonHeaders(),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

async function proxyRequest(request, response, url) {
  const pathname = url.pathname.slice("/screenhand".length);
  const method = request.method ?? "GET";
  if (!allowedProxyRoute(method, pathname)) {
    sendJson(response, 404, { ok: false, error: "Recorder proxy route not found." });
    return;
  }

  const upstreamUrl = new URL(`${pathname}${url.search}`, UPSTREAM);
  const body = method === "POST" ? await readRequestBody(request) : undefined;
  const upstreamResponse = await fetch(upstreamUrl, {
    method,
    headers: body?.length
      ? { "Content-Type": String(request.headers["content-type"] ?? "application/json") }
      : undefined,
    body: body?.length ? body : undefined,
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
  response.writeHead(upstreamResponse.status, {
    ...commonHeaders(),
    "Content-Type": upstreamResponse.headers.get("content-type") ?? "application/octet-stream",
    "Content-Length": String(bytes.length),
  });
  response.end(bytes);
}

async function staticFile(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(PUBLIC_ROOT, safe);
  if (!filePath.startsWith(PUBLIC_ROOT)) {
    sendJson(response, 404, { ok: false, error: "Not found." });
    return;
  }
  try {
    await access(filePath);
    const details = await stat(filePath);
    if (!details.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      ...commonHeaders(),
      "Content-Type": MIME_TYPES.get(extname(filePath)) ?? "application/octet-stream",
      "Content-Length": String(details.size),
      "Content-Security-Policy": [
        "default-src 'self'",
        "connect-src 'self' ws://127.0.0.1:3013 ws://localhost:3013",
        "img-src 'self' blob: data:",
        "style-src 'self'",
        "script-src 'self'",
      ].join("; "),
    });
    createReadStream(filePath).pipe(response);
  } catch {
    sendJson(response, 404, { ok: false, error: "Not found." });
  }
}

export function createRecorderServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          service: "ScreenHand Action Recorder",
          upstream: UPSTREAM.origin,
        });
        return;
      }
      if (url.pathname.startsWith("/screenhand/")) {
        await proxyRequest(request, response, url);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { ok: false, error: "Method not allowed." });
        return;
      }
      await staticFile(response, url.pathname);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Recorder request failed.";
      sendJson(response, 502, { ok: false, error: message });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createRecorderServer();
  server.listen(PORT, HOST, () => {
    console.log(`ScreenHand Action Recorder listening on http://${HOST}:${PORT}`);
    console.log(`Using ScreenHand control plane ${UPSTREAM.origin}`);
  });
}
