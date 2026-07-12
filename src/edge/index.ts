import {
  CreateRoomRequestSchema,
  JoinRoomRequestSchema,
  MIN_PARTICIPANT_CAPACITY_MESSAGE,
  RoomCodeSchema,
} from "./protocol";
import { createRoomCode } from "./relay";
import { RoomDurableObject } from "./room";
import type { MultiplayerEnv } from "./runtime";

export { RoomDurableObject };

const API_PREFIX = "/api/rooms";
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const multiplayerWorker = {
  async fetch(request: Request, env: MultiplayerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return preflight(request, env);

    const originError = validateOrigin(request, env);
    if (originError) return originError;

    if (request.method === "GET" && url.pathname === "/health") {
      return withCors(json({ ok: true, service: "hex-dominion-multiplayer" }), request, env);
    }

    if (request.method === "POST" && url.pathname === API_PREFIX) {
      const body = await parseJson(request);
      const parsed = CreateRoomRequestSchema.safeParse(body);
      if (!parsed.success) {
        const capacityIssue = parsed.error.issues.find(
          (issue) => issue.message === MIN_PARTICIPANT_CAPACITY_MESSAGE,
        );
        return withCors(
          problem(
            400,
            capacityIssue ? "insufficient-participant-capacity" : "invalid-create",
            capacityIssue?.message ?? "Invalid room creation request",
            parsed.error.issues,
          ),
          request,
          env,
        );
      }

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const code = createRoomCode();
        const stub = roomStub(env, code);
        const response = await stub.fetch(
          new Request("https://room.internal/internal/create", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-room-code": code,
            },
            body: JSON.stringify(parsed.data),
          }),
        );
        if (response.status === 409) continue;
        return withCors(await decorateIdentity(response, request, code), request, env);
      }
      return withCors(
        problem(503, "room-code-exhausted", "Could not reserve a unique room code"),
        request,
        env,
      );
    }

    const route = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(join|ws|status))?$/);
    if (!route) {
      return withCors(problem(404, "not-found", "Unknown multiplayer endpoint"), request, env);
    }
    const codeResult = RoomCodeSchema.safeParse(route[1]);
    if (!codeResult.success) {
      return withCors(
        problem(400, "invalid-room-code", "Expected a six-character room code"),
        request,
        env,
      );
    }
    const code = codeResult.data;
    const action = route[2] ?? "status";
    const stub = roomStub(env, code);

    if (request.method === "POST" && action === "join") {
      const body = await parseJson(request);
      const parsed = JoinRoomRequestSchema.safeParse(body);
      if (!parsed.success) {
        return withCors(
          problem(400, "invalid-join", "Invalid room join request", parsed.error.issues),
          request,
          env,
        );
      }
      const response = await stub.fetch(
        new Request("https://room.internal/internal/join", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parsed.data),
        }),
      );
      return withCors(await decorateIdentity(response, request, code), request, env);
    }

    if (request.method === "GET" && action === "status") {
      const response = await stub.fetch(new Request("https://room.internal/internal/status"));
      return withCors(response, request, env);
    }

    if (request.method === "GET" && action === "ws") {
      const internalUrl = new URL("https://room.internal/internal/ws");
      const token = url.searchParams.get("token");
      if (token) internalUrl.searchParams.set("token", token);
      return stub.fetch(
        new Request(internalUrl, {
          method: "GET",
          headers: request.headers,
        }),
      );
    }

    return withCors(problem(405, "method-not-allowed", "Method not allowed"), request, env);
  },
};

export default multiplayerWorker;

function roomStub(env: MultiplayerEnv, code: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(code));
}

async function decorateIdentity(
  response: Response,
  request: Request,
  code: string,
): Promise<Response> {
  if (!response.ok) return response;
  const payload = (await response.json()) as Record<string, unknown>;
  const token = String(payload.reconnectToken ?? "");
  const publicUrl = new URL(request.url);
  const socketProtocol = publicUrl.protocol === "https:" ? "wss:" : "ws:";
  payload.websocketUrl = `${socketProtocol}//${publicUrl.host}${API_PREFIX}/${code}/ws?token=${encodeURIComponent(token)}`;
  return json(payload, response.status);
}

function validateOrigin(request: Request, env: MultiplayerEnv): Response | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const requestOrigin = new URL(request.url).origin;
  const configured = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (
    origin === requestOrigin ||
    LOCAL_ORIGIN.test(origin) ||
    configured.includes("*") ||
    configured.includes(origin)
  ) {
    return null;
  }
  return problem(403, "origin-not-allowed", "Request origin is not allowed");
}

function preflight(request: Request, env: MultiplayerEnv): Response {
  const rejected = validateOrigin(request, env);
  if (rejected) return rejected;
  return withCors(new Response(null, { status: 204 }), request, env);
}

function withCors(response: Response, request: Request, env: MultiplayerEnv): Response {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("origin");
  const configured = (env.ALLOWED_ORIGINS ?? "").split(",").map((entry) => entry.trim());
  headers.set(
    "access-control-allow-origin",
    configured.includes("*") ? "*" : (origin ?? new URL(request.url).origin),
  );
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  headers.set("access-control-max-age", "86400");
  headers.append("vary", "origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function problem(status: number, code: string, message: string, details?: unknown): Response {
  return json({ error: { code, message, details } }, status);
}
