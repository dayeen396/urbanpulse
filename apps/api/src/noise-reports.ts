import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import multer from "multer";
import { parseBuffer } from "music-metadata";
import { z } from "zod";
import { authenticate, requireRoles, type AuthenticatedRequest } from "./auth";
import type { AudioStorage } from "./audio-storage";
import { config } from "./config";
import { HttpError } from "./errors";
import { pool } from "./db";

const MAX_AUDIO_SIZE_BYTES = config.MAX_AUDIO_SIZE_BYTES;
const MAX_AUDIO_DURATION_SECONDS = 10;
const allowedMimeTypes = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
]);

const locationSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
});

export interface NoiseReportJobQueue {
  add(name: string, data: { reportId: string }, options: {
    jobId: string;
    attempts: number;
    backoff: { type: "exponential"; delay: number };
    removeOnComplete: number;
    removeOnFail: number;
  }): Promise<{ id?: string }>;
}

export interface NoiseReportSummary {
  id: string;
  latitude: number;
  longitude: number;
  status: string;
  predictedClass: string | null;
  userLabel?: string | null;
  confidence: number | null;
  approximateDb: number | null;
  mode: string;
  modelVersion: string | null;
  analysis?: Record<string, unknown> | null;
  isSimulated: boolean;
  createdAt: string;
}

export type NoiseReportEvent =
  | { type: "report:new"; report: NoiseReportSummary }
  | { type: "report:processed"; report: NoiseReportSummary }
  | { type: "job:progress"; reportId: string; jobId: string; progress: number; status: "processing" | "processed" }
  | { type: "report:deleted"; reportId: string };

export interface NoiseRouterOptions {
  queue: NoiseReportJobQueue | undefined;
  storage: AudioStorage;
  publish: ((event: NoiseReportEvent) => void) | undefined;
}

interface NoiseReportRow {
  id: string;
  latitude: number;
  longitude: number;
  status: string;
  predicted_class: string | null;
  user_label?: string | null;
  confidence: number | null;
  db_level: number | null;
  mode: string;
  model_version: string | null;
  analysis?: Record<string, unknown> | null;
  is_simulated: boolean;
  created_at: Date;
  audio_path?: string | null;
}

function toSummary(row: NoiseReportRow): NoiseReportSummary {
  return {
    id: row.id,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    status: row.status,
    predictedClass: row.predicted_class,
    userLabel: row.user_label ?? null,
    confidence: row.confidence,
    approximateDb: row.db_level,
    mode: row.mode,
    modelVersion: row.model_version,
    ...(row.analysis !== undefined ? { analysis: row.analysis } : {}),
    isSimulated: row.is_simulated,
    createdAt: row.created_at.toISOString(),
  };
}

function asyncRoute(handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

async function validateAudioWithMlDecoder(file: Express.Multer.File): Promise<void> {
  let response: globalThis.Response;
  try {
    response = await fetch(`${config.ML_SERVICE_URL}/v1/noise/validate`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(file.buffer),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new HttpError(503, "Audio validation is temporarily unavailable. Please try again.", "AUDIO_VALIDATION_UNAVAILABLE");
  }
  if (response.status === 413) {
    throw new HttpError(413, "Audio clips must be 10 seconds or shorter.", "AUDIO_TOO_LONG");
  }
  if (response.status === 400 || response.status === 422) {
    throw new HttpError(400, "The uploaded file is not a readable audio clip.", "INVALID_AUDIO_FILE");
  }
  if (!response.ok) {
    throw new HttpError(503, "Audio validation is temporarily unavailable. Please try again.", "AUDIO_VALIDATION_UNAVAILABLE");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HttpError(503, "Audio validation returned an invalid response.", "AUDIO_VALIDATION_UNAVAILABLE");
  }
  const validation = z.object({ duration_seconds: z.number().positive().finite() }).safeParse(payload);
  if (!validation.success) {
    throw new HttpError(503, "Audio validation returned an invalid response.", "AUDIO_VALIDATION_UNAVAILABLE");
  }
  if (validation.data.duration_seconds > MAX_AUDIO_DURATION_SECONDS) {
    throw new HttpError(413, "Audio clips must be 10 seconds or shorter.", "AUDIO_TOO_LONG");
  }
}

async function validateAudioDuration(file: Express.Multer.File): Promise<void> {
  const mimeType = file.mimetype.split(";")[0]?.toLowerCase();
  if (!mimeType || !allowedMimeTypes.has(mimeType)) {
    throw new HttpError(415, "Upload a supported audio file (WebM, Ogg, WAV, MP3, AAC, or M4A).", "UNSUPPORTED_AUDIO_TYPE");
  }
  let metadata;
  try {
    metadata = await parseBuffer(file.buffer, { mimeType });
  } catch {
    await validateAudioWithMlDecoder(file);
    return;
  }
  const duration = metadata.format.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    await validateAudioWithMlDecoder(file);
    return;
  }
  if (duration > MAX_AUDIO_DURATION_SECONDS) {
    throw new HttpError(413, "Audio clips must be 10 seconds or shorter.", "AUDIO_TOO_LONG");
  }
}

export function createNoiseReportsRouter(options: NoiseRouterOptions): Router {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_SIZE_BYTES, files: 1, fields: 4, parts: 5 },
    fileFilter: (_request, file, callback) => {
      const mimeType = file.mimetype.split(";")[0]?.toLowerCase();
      if (!mimeType || !allowedMimeTypes.has(mimeType)) {
        callback(new HttpError(415, "Upload a supported audio file (WebM, Ogg, WAV, MP3, AAC, or M4A).", "UNSUPPORTED_AUDIO_TYPE"));
        return;
      }
      callback(null, true);
    },
  });

  router.get("/", asyncRoute(async (request, response) => {
    const querySchema = z.object({
      bbox: z.string().optional(),
      since: z.string().datetime({ offset: true }).optional(),
      class: z.string().trim().min(1).max(40).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(250),
    });
    const filters = querySchema.parse(request.query);
    const conditions = ["status <> 'failed'"];
    const values: Array<string | number> = [];

    if (filters.bbox) {
      const bbox = z.array(z.coerce.number()).length(4).parse(filters.bbox.split(","));
      const [west, south, east, north] = bbox;
      if (west === undefined || south === undefined || east === undefined || north === undefined ||
        west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
        throw new HttpError(400, "bbox must be west,south,east,north coordinates in valid ranges.", "INVALID_BBOX");
      }
      values.push(west, south, east, north);
      conditions.push(`geom && ST_MakeEnvelope($${values.length - 3}, $${values.length - 2}, $${values.length - 1}, $${values.length}, 4326)`);
    }
    if (filters.since) {
      values.push(filters.since);
      conditions.push(`created_at >= $${values.length}`);
    }
    if (filters.class) {
      values.push(filters.class);
      conditions.push(`predicted_class = $${values.length}`);
    }
    values.push(filters.limit);

    const result = await pool.query<NoiseReportRow>(
      `SELECT id, ROUND(ST_Y(geom)::numeric, 4) AS latitude,
              ROUND(ST_X(geom)::numeric, 4) AS longitude, status,
              predicted_class, confidence, db_level, mode, model_version,
              is_simulated, created_at
       FROM noise_reports
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${values.length}`,
      values,
    );
    response.json({ reports: result.rows.map(toSummary) });
  }));

  router.get("/mine", authenticate, asyncRoute(async (request, response) => {
    const authRequest = request as AuthenticatedRequest;
    const result = await pool.query<NoiseReportRow>(
      `SELECT id, ROUND(ST_Y(geom)::numeric, 4) AS latitude,
              ROUND(ST_X(geom)::numeric, 4) AS longitude, status,
              predicted_class, user_label, confidence, db_level, mode, model_version, analysis,
              is_simulated, created_at
       FROM noise_reports
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [authRequest.auth?.userId],
    );
    response.json({ reports: result.rows.map(toSummary) });
  }));

  router.patch("/:reportId/label", authenticate, asyncRoute(async (request, response) => {
    const reportId = z.string().uuid().parse(request.params.reportId);
    const { label } = z.object({ label: z.enum(["horn", "construction", "siren", "traffic", "engine", "crowd", "other"]) }).parse(request.body);
    const authRequest = request as AuthenticatedRequest;
    const result = await pool.query<NoiseReportRow>(
      `UPDATE noise_reports
       SET user_label = $3
       WHERE id = $1 AND user_id = $2 AND status = 'processed'
       RETURNING id, ROUND(ST_Y(geom)::numeric, 4) AS latitude,
                 ROUND(ST_X(geom)::numeric, 4) AS longitude, status,
                 predicted_class, user_label, confidence, db_level, mode, model_version, analysis,
                 is_simulated, created_at`,
      [reportId, authRequest.auth?.userId, label],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Processed noise report not found.", "REPORT_NOT_FOUND");
    response.json({ report: toSummary(row) });
  }));

  router.post("/", authenticate, requireRoles("citizen"), upload.single("audio"), asyncRoute(async (request, response) => {
    const audio = request.file;
    if (!audio) throw new HttpError(400, "An audio file is required.", "AUDIO_REQUIRED");
    const location = locationSchema.parse(request.body);
    const mimeType = audio.mimetype.split(";")[0]?.toLowerCase() ?? "";
    await validateAudioDuration(audio);
    if (!options.queue) throw new HttpError(503, "Audio processing is temporarily unavailable.", "PROCESSING_UNAVAILABLE");
    if (!options.publish) throw new HttpError(503, "Live report updates are temporarily unavailable.", "REALTIME_UNAVAILABLE");

    const authRequest = request as AuthenticatedRequest;
    const storageKey = await options.storage.saveAudio(audio.buffer, mimeType);
    let report: NoiseReportSummary | undefined;
    try {
      const inserted = await pool.query<NoiseReportRow>(
        `INSERT INTO noise_reports (user_id, geom, audio_path, status, mode, is_simulated)
         VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, 'pending', 'stub', false)
         RETURNING id, ST_Y(geom) AS latitude, ST_X(geom) AS longitude, status,
                   predicted_class, confidence, db_level, mode, model_version, is_simulated, created_at`,
        [authRequest.auth?.userId, location.longitude, location.latitude, storageKey],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("Noise report insert returned no row");
      report = toSummary(row);
      const job = await options.queue.add("noise.classify", { reportId: report.id }, {
        jobId: report.id,
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
      options.publish({
        type: "report:new",
        report: {
          ...report,
          latitude: Number(report.latitude.toFixed(4)),
          longitude: Number(report.longitude.toFixed(4)),
        },
      });
      response.status(202).json({ report, jobId: job.id ?? report.id });
    } catch (error) {
      if (report) {
        await pool.query("DELETE FROM noise_reports WHERE id = $1", [report.id]).catch((cleanupError: unknown) => {
          console.error(`Failed to remove report ${report?.id} after queue failure`, cleanupError);
        });
      }
      await options.storage.removeAudio(storageKey).catch((cleanupError: unknown) => {
        console.error("Failed to remove orphaned audio after submission failure", cleanupError);
      });
      throw error;
    }
  }));

  router.delete("/:reportId", authenticate, asyncRoute(async (request, response) => {
    const reportId = z.string().uuid().parse(request.params.reportId);
    const authRequest = request as AuthenticatedRequest;
    const selected = await pool.query<{ audio_path: string | null }>(
      "SELECT audio_path FROM noise_reports WHERE id = $1 AND user_id = $2",
      [reportId, authRequest.auth?.userId],
    );
    const row = selected.rows[0];
    if (!row) throw new HttpError(404, "Noise report not found.", "REPORT_NOT_FOUND");
    if (row.audio_path) await options.storage.removeAudio(row.audio_path);
    await pool.query("DELETE FROM noise_reports WHERE id = $1 AND user_id = $2", [reportId, authRequest.auth?.userId]);
    options.publish?.({ type: "report:deleted", reportId });
    response.status(204).end();
  }));

  return router;
}
