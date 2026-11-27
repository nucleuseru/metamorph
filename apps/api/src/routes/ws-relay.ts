import { EngineOrchestrator } from "@metamorph/orchestrator";
import { TERMINAL_SESSION_STATUSES } from "@metamorph/shared";
import { Effect, Fiber } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";

import { toHeaders } from "../lib/headers.ts";
import { Auth } from "../services/auth.ts";
import { EngineTokenService } from "../services/engine-tokens.ts";

const toSafeCloseEvent = (err: unknown): Socket.CloseEvent => {
  if (Socket.isSocketError(err) && err.reason._tag === "SocketCloseError") {
    const code = err.reason.code;
    // RFC 6455: codes 1005, 1006, 1015 must not be sent on the wire
    const safeCode = code === 1005 || code === 1006 || code === 1015 ? 1000 : code;
    return new Socket.CloseEvent(safeCode, err.reason.closeReason);
  }
  return new Socket.CloseEvent(1011, "Upstream relay error");
};

const forwardFrames = (
  reader: Socket.Reader,
  writer: Socket.Writer,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    while (true) {
      const batch = yield* reader.pull;
      yield* writer.writeAll(batch);
    }
  }).pipe(Effect.catch((err) => writer.write(toSafeCloseEvent(err)).pipe(Effect.ignore)));

/**
 * Transparent bidirectional WebSocket relay (`GET /sessions/:id/ws`) for clients
 * connecting through `apps/api` (e.g. non-TLS Vast.ai direct IP endpoints).
 * Preserves WebSocket text vs binary frame opcodes in both directions.
 */
export const SessionWsRelayRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    const tokenService = yield* EngineTokenService;
    const orchestrator = yield* EngineOrchestrator;
    const wsConstructor = yield* Socket.WebSocketConstructor;

    return yield* router.add(
      "GET",
      "/sessions/:id/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const params = yield* HttpRouter.params;

        const sessionId = params["id"];
        if (!sessionId) {
          return HttpServerResponse.text("Missing session id", { status: 400 });
        }

        const url = HttpServerRequest.toURL(request);
        const queryToken = url._tag === "Some" ? url.value.searchParams.get("token") : null;

        let userId: string | null = null;
        if (queryToken) {
          const verified = yield* tokenService
            .verifySessionToken(queryToken, sessionId)
            .pipe(Effect.result);
          if (verified._tag === "Success") {
            userId = verified.success.sub;
          }
        }

        if (userId === null) {
          const session = yield* auth
            .getSession(toHeaders(request.headers))
            .pipe(Effect.orElseSucceed(() => null));
          userId = session?.user.id ?? null;
        }

        if (userId === null) {
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        }

        const record = yield* orchestrator.getSessionForUser(sessionId, userId).pipe(Effect.result);
        if (record._tag === "Failure") {
          return HttpServerResponse.text("Session not found", { status: 404 });
        }

        const inst = record.success;
        if (
          !inst.wsUrl ||
          TERMINAL_SESSION_STATUSES.has(inst.status) ||
          inst.status === "provisioning" ||
          inst.status === "warming" ||
          inst.status === "stopping"
        ) {
          return HttpServerResponse.text(`Session is not ready (status=${inst.status})`, {
            status: 409,
          });
        }

        const engineSocket = yield* Socket.makeWebSocket(inst.wsUrl, {
          openTimeout: "10 seconds",
        }).pipe(Effect.provideService(Socket.WebSocketConstructor, wsConstructor));

        // Acquire upstream engine connection before upgrading the client socket so
        // unreachable engines return HTTP 502 cleanly instead of failing post-101.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const engineReader = yield* engineSocket.reader;
            const engineWriter = yield* engineSocket.writer;
            const clientSocket = yield* request.upgrade;
            const clientReader = yield* clientSocket.reader;
            const clientWriter = yield* clientSocket.writer;

            const upFiber = yield* forwardFrames(clientReader, engineWriter).pipe(Effect.forkChild);
            const downFiber = yield* forwardFrames(engineReader, clientWriter).pipe(
              Effect.forkChild,
            );

            yield* Effect.raceFirst(Fiber.await(upFiber), Fiber.await(downFiber));
            yield* Fiber.interrupt(upFiber);
            yield* Fiber.interrupt(downFiber);
          }),
        );

        return HttpServerResponse.empty({ status: 101 });
      }).pipe(
        Effect.catch((err) =>
          Effect.logWarning("Session WS relay terminated with error", err).pipe(
            Effect.as(HttpServerResponse.text("WebSocket upgrade failed", { status: 502 })),
          ),
        ),
      ),
    );
  }),
);
