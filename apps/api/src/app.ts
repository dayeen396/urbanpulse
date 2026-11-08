import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { LocalAudioStorage, type AudioStorage } from "./audio-storage";
import { authenticate, login, refresh, register, requireRoles, revokeRefreshToken, type AuthenticatedRequest } from "./auth";
import { config } from "./config";
import { pool } from "./db";
import { errorHandler, HttpError } from "./errors";
import { createNoiseReportsRouter, type NoiseReportEvent, type NoiseReportJobQueue } from "./noise-reports";

const openApiDocument = {
  openapi: "3.0.3",
  info: { title: "UrbanPulse API", version: "0.1.0", description: "Citizen audio reports and public noise map" },
  servers: [{ url: "/api/v1" }],
  paths: {
    "/auth/register": { post: { summary: "Register a citizen account", responses: { "201": { description: "Account created" } } } },
    "/auth/login": { post: { summary: "Log in", responses: { "200": { description: "Authenticated" } } } },
    "/auth/refresh": { post: { summary: "Rotate refresh token", responses: { "200": { description: "Tokens rotated" } } } },
    "/auth/me": { get: { summary: "Get the current user", responses: { "200": { description: "Current user" } } } },
    "/reports/noise": {
      get: { summary: "List public noise reports for the map", responses: { "200": { description: "Noise report summaries" } } },
      post: {
        summary: "Submit an audio report for asynchronous classification",
        security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["audio", "latitude", "longitude"], properties: { audio: { type: "string", format: "binary" }, latitude: { type: "number" }, longitude: { type: "number" } } } } } },
        responses: { "202": { description: "Report accepted and queued" }, "400": { description: "Invalid audio or location" }, "413": { description: "Audio exceeds limits" } },
      },
    },
    "/reports/noise/mine": { get: { summary: "List the authenticated user's reports", security: [{ bearerAuth: [] }], responses: { "200": { description: "Own noise report summaries" } } } },
    "/reports/noise/{reportId}/label": { patch: { summary: "Confirm or correct an owned processed noise label", security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["label"], properties: { label: { type: "string", enum: ["horn", "construction", "siren", "traffic", "engine", "crowd", "other"] } } } } } }, responses: { "200": { description: "Corrected label saved for future training" }, "404": { description: "Owned processed report not found" } } } },
    "/reports/noise/{reportId}": { delete: { summary: "Delete an owned report and its private audio file", security: [{ bearerAuth: [] }], responses: { "204": { description: "Report deleted" } } } },
    "/admin/noise-metrics": { get: { summary: "Get actual held-out noise model evaluation metrics", security: [{ bearerAuth: [] }], responses: { "200": { description: "Classical and neural model metrics, or explicit untrained status" }, "403": { description: "Admin role required" } } } },
    "/health/ready": { get: { summary: "Readiness check", responses: { "200": { description: "Dependencies available" } } } },
  },
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
};

function asyncRoute(handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

function createRateLimiter(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_request, response) => {
      response.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests; try again later." } });
    },
  });
}

export function createApp(options: {
  noiseQueue?: NoiseReportJobQueue;
  audioStorage?: AudioStorage;
  publishNoiseEvent?: (event: NoiseReportEvent) => void;
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "32kb" }));
  app.use("/api/v1/auth", createRateLimiter(15 * 60 * 1000, 30));

  app.get("/health/live", (_request, response) => response.json({ status: "ok" }));
  app.get("/health/ready", asyncRoute(async (_request, response) => {
    await pool.query("SELECT 1");
    response.json({ status: "ready", dependencies: { database: "ok" } });
  }));
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

  const api = express.Router();
  api.post("/auth/register", asyncRoute(async (request, response) => {
    response.status(201).json(await register(request.body?.email, request.body?.password, request.body?.displayName));
  }));
  api.post("/auth/login", asyncRoute(async (request, response) => {
    response.json(await login(request.body?.email, request.body?.password));
  }));
  api.post("/auth/refresh", asyncRoute(async (request, response) => {
    response.json(await refresh(request.body?.refreshToken));
  }));
  api.post("/auth/logout", authenticate, asyncRoute(async (request, response) => {
    await revokeRefreshToken(request.body?.refreshToken);
    response.status(204).end();
  }));
  api.get("/auth/me", authenticate, asyncRoute(async (request, response) => {
    const authRequest = request as AuthenticatedRequest;
    if (!authRequest.auth) throw new HttpError(401, "Authentication required", "UNAUTHENTICATED");
    response.json({ userId: authRequest.auth.userId, role: authRequest.auth.role });
  }));
  api.get("/admin/access-check", authenticate, requireRoles("admin"), (_request, response) => {
    response.json({ allowed: true });
  });
  api.get("/admin/noise-metrics", authenticate, requireRoles("admin"), asyncRoute(async (_request, response) => {
    const metricsResponse = await fetch(`${config.ML_SERVICE_URL}/v1/noise/metrics`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!metricsResponse.ok) {
      throw new HttpError(503, "Noise model metrics are temporarily unavailable.", "ML_METRICS_UNAVAILABLE");
    }
    const metrics: unknown = await metricsResponse.json();
    if (typeof metrics !== "object" || metrics === null || !("task" in metrics) || metrics.task !== "noise-classification") {
      throw new HttpError(502, "ML service returned invalid noise model metrics.", "INVALID_ML_METRICS");
    }
    response.json(metrics);
  }));
  api.use("/reports/noise", createRateLimiter(60 * 1000, 20));
  api.use("/reports/noise", createNoiseReportsRouter({
    queue: options.noiseQueue,
    storage: options.audioStorage ?? new LocalAudioStorage(),
    publish: options.publishNoiseEvent,
  }));
  app.use("/api/v1", api);

  app.use((_request, response) => {
    response.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });
  app.use(errorHandler);
  return app;
}
