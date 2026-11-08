import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { Pool } from "pg";

interface NoiseReportJobData {
  reportId: string;
}

interface NoiseClassification {
  predicted_class: string;
  confidence: number;
  approximate_db: number | null;
  model_version: string;
  mode: string;
  analysis: Record<string, unknown>;
}

interface ReportRow {
  audio_path: string | null;
}

interface ProcessedRow {
  id: string;
  latitude: number;
  longitude: number;
  status: string;
  predicted_class: string | null;
  user_label: string | null;
  confidence: number | null;
  db_level: number | null;
  mode: string;
  model_version: string | null;
  analysis: Record<string, unknown> | null;
  is_simulated: boolean;
  created_at: Date;
}

const redisUrl = process.env.REDIS_URL;
const databaseUrl = process.env.DATABASE_URL;
const mlServiceUrl = process.env.ML_SERVICE_URL ?? "http://ml:8000";
const storageRoot = path.resolve(process.env.STORAGE_DIR ?? "uploads");
const deleteAfterProcessing = process.env.DELETE_AUDIO_AFTER_PROCESSING === "true";
if (!redisUrl) throw new Error("REDIS_URL is required");
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const eventPublisher = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const pool = new Pool({ connectionString: databaseUrl });

function resolveAudioPath(key: string): string {
  if (!/^noise\/[0-9a-f-]+\.(webm|ogg|wav|mp3|m4a|aac)$/.test(key)) {
    throw new Error("Report contains an invalid audio storage key");
  }
  const resolved = path.resolve(storageRoot, key);
  if (!resolved.startsWith(`${storageRoot}${path.sep}`)) throw new Error("Audio path escapes storage root");
  return resolved;
}

function isNoiseClassification(value: unknown): value is NoiseClassification {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  const classes = new Set(["horn", "construction", "siren", "traffic", "engine", "crowd", "other"]);
  return typeof result.predicted_class === "string" &&
    classes.has(result.predicted_class) &&
    typeof result.confidence === "number" &&
    Number.isFinite(result.confidence) &&
    result.confidence >= 0 &&
    result.confidence <= 1 &&
    (typeof result.approximate_db === "number" || result.approximate_db === null) &&
    (result.approximate_db === null || (Number.isFinite(result.approximate_db) && result.approximate_db >= 0 && result.approximate_db <= 180)) &&
    typeof result.model_version === "string" &&
    result.model_version.length > 0 &&
    (result.mode === "stub" || result.mode === "classical" || result.mode === "random_forest" || result.mode === "neural" || result.mode === "fallback") &&
    typeof result.analysis === "object" &&
    result.analysis !== null &&
    !Array.isArray(result.analysis);
}

async function classify(audioKey: string): Promise<NoiseClassification> {
  const audio = await readFile(resolveAudioPath(audioKey));
  const response = await fetch(`${mlServiceUrl}/v1/noise/classify`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(audio),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`ML service returned HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!isNoiseClassification(payload)) throw new Error("ML service returned an invalid classification response");
  return payload;
}

async function publishProcessed(row: ProcessedRow): Promise<void> {
  await eventPublisher.publish("urbanpulse:events", JSON.stringify({
    type: "report:processed",
    report: {
      id: row.id,
      latitude: Number(Number(row.latitude).toFixed(4)),
      longitude: Number(Number(row.longitude).toFixed(4)),
      status: row.status,
      predictedClass: row.predicted_class,
      userLabel: row.user_label,
      confidence: row.confidence,
      approximateDb: row.db_level,
      mode: row.mode,
      modelVersion: row.model_version,
      isSimulated: row.is_simulated,
      createdAt: row.created_at.toISOString(),
    },
  }));
}

async function publishProgress(reportId: string, jobId: string, progress: number): Promise<void> {
  await eventPublisher.publish("urbanpulse:events", JSON.stringify({
    type: "job:progress",
    reportId,
    jobId,
    progress,
    status: progress === 100 ? "processed" : "processing",
  }));
}

async function failReport(reportId: string): Promise<void> {
  const result = await pool.query<ProcessedRow>(
    `UPDATE noise_reports
     SET status = 'failed'
     WHERE id = $1 AND status <> 'processed'
     RETURNING id, ST_Y(geom) AS latitude, ST_X(geom) AS longitude, status,
               predicted_class, user_label, confidence, db_level, mode, model_version, is_simulated, created_at`,
    [reportId],
  );
  const row = result.rows[0];
  if (row) await publishProcessed(row);
}

async function processNoiseReport(job: Job<NoiseReportJobData>): Promise<void> {
  const selected = await pool.query<ReportRow>(
    "SELECT audio_path FROM noise_reports WHERE id = $1 AND status <> 'processed'",
    [job.data.reportId],
  );
  const report = selected.rows[0];
  if (!report) {
    console.log(`Skipping removed or already-processed noise report ${job.data.reportId}`);
    return;
  }
  if (!report.audio_path) throw new Error("Noise report has no audio available for processing");
  await pool.query("UPDATE noise_reports SET status = 'processing' WHERE id = $1", [job.data.reportId]);

  try {
    await job.updateProgress(10);
    await publishProgress(job.data.reportId, String(job.id), 10);
    const prediction = await classify(report.audio_path);
    await job.updateProgress(80);
    await publishProgress(job.data.reportId, String(job.id), 80);
    const updated = await pool.query<ProcessedRow>(
      `UPDATE noise_reports
       SET status = 'processed', predicted_class = $2, confidence = $3,
           db_level = $4, mode = $5, model_version = $6, analysis = $7::jsonb
       WHERE id = $1
       RETURNING id, ST_Y(geom) AS latitude, ST_X(geom) AS longitude, status,
                 predicted_class, user_label, confidence, db_level, mode, model_version, analysis, is_simulated, created_at`,
      [
        job.data.reportId,
        prediction.predicted_class,
        prediction.confidence,
        prediction.approximate_db,
        prediction.mode,
        prediction.model_version,
        JSON.stringify(prediction.analysis),
      ],
    );
    const processed = updated.rows[0];
    if (!processed) return;
    await publishProcessed(processed);
    await publishProgress(job.data.reportId, String(job.id), 100);
    if (deleteAfterProcessing) {
      try {
        await rm(resolveAudioPath(report.audio_path), { force: true });
        await pool.query("UPDATE noise_reports SET audio_path = NULL WHERE id = $1", [job.data.reportId]);
      } catch (error) {
        console.error(`Could not delete processed audio for report ${job.data.reportId}`, error);
      }
    }
    await job.updateProgress(100);
    console.log(`Processed noise report ${job.data.reportId} using ${prediction.model_version} (${prediction.mode})`);
  } catch (error) {
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (finalAttempt) await failReport(job.data.reportId);
    throw error;
  }
}

const worker = new Worker<NoiseReportJobData>("urbanpulse-jobs", async (job) => {
  if (job.name !== "noise.classify") throw new Error(`Unsupported job type: ${job.name}`);
  await processNoiseReport(job);
}, { connection });

worker.on("ready", () => console.log("UrbanPulse worker connected and ready."));
worker.on("failed", (job, error) => console.error(`Job ${job?.id ?? "unknown"} failed`, error));
worker.on("error", (error) => console.error("Worker error", error));

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down worker`);
  await worker.close();
  await Promise.all([connection.quit(), eventPublisher.quit(), pool.end()]);
}

process.on("SIGTERM", () => void shutdown("SIGTERM").catch((error: unknown) => {
  console.error("Worker shutdown failed", error);
  process.exitCode = 1;
}));
process.on("SIGINT", () => void shutdown("SIGINT").catch((error: unknown) => {
  console.error("Worker shutdown failed", error);
  process.exitCode = 1;
}));
