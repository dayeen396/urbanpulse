import { createServer } from "node:http";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { Server as SocketServer } from "socket.io";
import { createApp } from "./app";
import { config } from "./config";
import { pool } from "./db";
import type { NoiseReportEvent, NoiseReportSummary } from "./noise-reports";

type ProcessedEvent = Extract<NoiseReportEvent, { type: "report:processed" }>;
type JobProgressEvent = Extract<NoiseReportEvent, { type: "job:progress" }>;

function isProcessedEvent(value: unknown): value is ProcessedEvent {
  if (typeof value !== "object" || value === null || !("type" in value) || !("report" in value)) return false;
  const event = value as { type: unknown; report: unknown };
  if (event.type !== "report:processed" || typeof event.report !== "object" || event.report === null) return false;
  const report = event.report as Partial<NoiseReportSummary>;
  return typeof report.id === "string" &&
    typeof report.status === "string" &&
    typeof report.latitude === "number" &&
    typeof report.longitude === "number";
}

function isJobProgressEvent(value: unknown): value is JobProgressEvent {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const event = value as { type: unknown; reportId?: unknown; jobId?: unknown; progress?: unknown; status?: unknown };
  return event.type === "job:progress" &&
    typeof event.reportId === "string" &&
    typeof event.jobId === "string" &&
    typeof event.progress === "number" &&
    event.progress >= 0 &&
    event.progress <= 100 &&
    (event.status === "processing" || event.status === "processed");
}

const queueConnection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
const eventSubscriber = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
const noiseQueue = new Queue("urbanpulse-jobs", { connection: queueConnection });
const realtime = { publish: undefined as ((event: NoiseReportEvent) => void) | undefined };

const app = createApp({
  noiseQueue,
  publishNoiseEvent: (event) => {
    if (!realtime.publish) throw new Error("Realtime event server is not ready");
    realtime.publish(event);
  },
});
const server = createServer(app);
const socketServer = new SocketServer(server, {
  cors: { origin: config.CORS_ORIGIN, methods: ["GET", "POST"] },
});
realtime.publish = (event) => {
  if (event.type === "report:deleted") socketServer.emit(event.type, { reportId: event.reportId });
  else if (event.type === "job:progress") socketServer.emit(event.type, event);
  else socketServer.emit(event.type, event.report);
};

eventSubscriber.on("error", (error) => console.error("Realtime event subscriber error", error));
eventSubscriber.on("message", (channel, message) => {
  if (channel !== "urbanpulse:events" || !socketServer) return;
  try {
    const event: unknown = JSON.parse(message);
    if (isProcessedEvent(event)) socketServer.emit(event.type, event.report);
    else if (isJobProgressEvent(event)) socketServer.emit(event.type, event);
    else throw new Error("Unexpected realtime event payload");
  } catch (error) {
    console.error("Rejected invalid realtime event message", error);
  }
});

const port = config.PORT;
const waitForRedisReady = () => eventSubscriber.status === "ready"
  ? Promise.resolve()
  : new Promise<void>((resolve) => eventSubscriber.once("ready", resolve));

void waitForRedisReady().then(() => eventSubscriber.subscribe("urbanpulse:events")).then(() => {
  server.listen(port, "0.0.0.0", () => {
    console.log(`UrbanPulse API listening on port ${port}`);
  });
}).catch((error: unknown) => {
  console.error("API startup failed before realtime subscription became ready", error);
  process.exitCode = 1;
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down API`);
  if (socketServer) {
    await new Promise<void>((resolve) => socketServer?.close(() => resolve()));
  } else {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await Promise.all([
    noiseQueue.close(),
    queueConnection.quit(),
    eventSubscriber.quit(),
    pool.end(),
  ]);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      console.error("API shutdown failed", error);
      process.exitCode = 1;
    });
  });
}
