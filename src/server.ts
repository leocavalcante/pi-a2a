import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { timingSafeEqual } from "node:crypto";
import { AgentCard, formatSSEEvent } from "@a2a-js/sdk";
import { A2AError } from "@a2a-js/sdk/errors";
import {
  JsonRpcTransportHandler,
  ServerCallContext,
  validateVersion,
  type A2ARequestHandler,
} from "@a2a-js/sdk/server";

export { peerBearerAuth, peerName } from "./peers.ts";

/** Suggested HTTP body ceiling for explicitly image-enabled hosts; default remains 64 KiB. */
export const A2A_IMAGE_MAX_BODY_BYTES = 6 * 1024 * 1024;
/** One 4 MiB document plus four 1 MiB images, base64 encoded. Defaults remain unchanged. */
export const A2A_DOCUMENT_MAX_BODY_BYTES = 12 * 1024 * 1024;

export interface HttpOptions {
  path?: string;
  /** Host-owned authentication. Return a stable identity, never the credential itself. */
  authenticate?: (
    request: IncomingMessage,
  ) => string | undefined | Promise<string | undefined>;
  /** For local demos or an explicitly trusted loopback adapter, not public deployment. */
  allowUnauthenticatedLoopback?: boolean;
  maxBodyBytes?: number;
}
const loopback = (address?: string) =>
  address === "127.0.0.1" ||
  address === "::1" ||
  address === "::ffff:127.0.0.1";
const safeFailure = (error: unknown): never => {
  if (error instanceof A2AError) throw error;
  throw new Error(
    "Agent unavailable. Inspect the existing task before retrying.",
  );
};

/** SDK wire codec/dispatch, with sanitized failures from the application/storage boundary. */
function safeHandler(handler: A2ARequestHandler): A2ARequestHandler {
  return new Proxy(handler, {
    get(target, property) {
      const method = Reflect.get(target, property);
      if (typeof method !== "function") return method;
      return (...args: unknown[]) => {
        try {
          const result = method.apply(target, args);
          if (result && typeof result[Symbol.asyncIterator] === "function") {
            return (async function* () {
              try {
                yield* result;
              } catch (error) {
                safeFailure(error);
              }
            })();
          }
          return Promise.resolve(result).catch(safeFailure);
        } catch (error) {
          return Promise.reject().catch(() => safeFailure(error));
        }
      };
    },
  });
}

/** Mount alongside an application's existing health/status routes. Returns false for unrelated routes. */
export function a2aHttpHandler(
  handler: A2ARequestHandler,
  options: HttpOptions = {},
) {
  const path = options.path ?? "/a2a";
  const transport = new JsonRpcTransportHandler(safeHandler(handler));
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== path && pathname !== "/.well-known/agent-card.json")
      return false;
    const send = (code: number, body: unknown) => {
      response.writeHead(code, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(body));
    };
    // Remote production traffic must terminate TLS before this handler (a local TLS proxy is fine).
    if (
      !loopback(request.socket.remoteAddress) &&
      !(request.socket as { encrypted?: boolean }).encrypted
    ) {
      send(400, { error: "HTTPS is required for non-loopback A2A traffic." });
      return true;
    }
    let identity: string | undefined;
    try {
      identity = options.authenticate
        ? await options.authenticate(request)
        : options.allowUnauthenticatedLoopback &&
            loopback(request.socket.remoteAddress)
          ? "loopback-owner"
          : undefined;
    } catch {
      /* Fail closed without credential-store diagnostics. */
    }
    if (!identity) {
      response.setHeader("WWW-Authenticate", "Bearer");
      send(401, { error: "Authentication required." });
      return true;
    }
    const controller = new AbortController();
    const disconnect = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.on("close", disconnect);
    try {
      if (
        request.method === "GET" &&
        pathname === "/.well-known/agent-card.json"
      ) {
        send(200, AgentCard.toJSON(await handler.getAgentCard()));
        return true;
      }
      if (request.method !== "POST" || pathname !== path) {
        send(405, { error: "Use JSON-RPC POST or Agent Card GET." });
        return true;
      }
      const context = new ServerCallContext({
        user: { isAuthenticated: true, userName: identity },
        requestedVersion:
          typeof request.headers["a2a-version"] === "string"
            ? request.headers["a2a-version"]
            : "0.3",
        state: new Map([["signal", controller.signal]]),
      });
      try {
        validateVersion(
          context.requestedVersion,
          await handler.getAgentCard(),
          "JSONRPC",
        );
      } catch (error) {
        send(400, {
          jsonrpc: "2.0",
          id: null,
          error: JsonRpcTransportHandler.mapToJSONRPCError(error),
        });
        return true;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > (options.maxBodyBytes ?? 65_536)) {
          send(413, { error: "A2A request body exceeds the byte limit." });
          return true;
        }
        chunks.push(Buffer.from(chunk));
      }
      let document: Record<string, unknown>;
      try {
        document = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        send(200, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        return true;
      }
      const result = await transport.handle(document, context);
      if (Symbol.asyncIterator in result) {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.flushHeaders();
        for await (const event of result) {
          if (controller.signal.aborted) break;
          if (!response.write(formatSSEEvent(event)))
            await once(response, "drain", { signal: controller.signal });
        }
        response.end();
      } else send(200, result);
    } catch {
      if (!response.destroyed) {
        if (response.headersSent) response.end();
        else
          send(503, {
            error:
              "Agent unavailable. Inspect the original task before retrying.",
          });
      }
    } finally {
      response.off("close", disconnect);
    }
    return true;
  };
}

/** Local HTTP convenience server. Production hosts should mount a2aHttpHandler behind TLS. */
export function createA2AServer(
  handler: A2ARequestHandler,
  options: HttpOptions = {},
) {
  const route = a2aHttpHandler(handler, options);
  return createServer((request, response) => {
    void route(request, response)
      .then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      })
      .catch(() => {
        response.destroy();
      });
  });
}

export function bearerAuth(
  readToken: () => string | undefined,
  identity = "owner",
): HttpOptions["authenticate"] {
  return (request) => {
    const expected = readToken();
    const received = request.headers.authorization;
    if (!expected || !received || received.length > 16_384) return undefined;
    const a = Buffer.from(`Bearer ${expected}`),
      b = Buffer.from(received);
    return a.length === b.length && timingSafeEqual(a, b)
      ? identity
      : undefined;
  };
}
