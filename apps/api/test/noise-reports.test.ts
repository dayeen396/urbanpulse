import jwt from "jsonwebtoken";
import request from "supertest";
import { pool } from "../src/db";
import { createApp } from "../src/app";
import { config } from "../src/config";
import type { AudioStorage } from "../src/audio-storage";
import type { NoiseReportEvent, NoiseReportJobQueue } from "../src/noise-reports";

jest.mock("../src/db", () => ({ pool: { query: jest.fn() } }));

function createWavBuffer(durationSeconds: number): Buffer {
  const sampleRate = 8_000;
  const dataLength = sampleRate * durationSeconds * 2;
  const wav = Buffer.alloc(44 + dataLength);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataLength, 40);
  return wav;
}

describe("noise report routes", () => {
  const userId = "00000000-0000-4000-8000-000000000001";
  const token = jwt.sign(
    { role: "citizen", type: "access" },
    config.JWT_ACCESS_SECRET,
    { subject: userId, expiresIn: "5m" },
  );
  const query = jest.mocked(pool.query);

  beforeEach(() => {
    query.mockReset();
  });

  it("requires authentication before accepting private audio", async () => {
    const response = await request(createApp())
      .post("/api/v1/reports/noise")
      .attach("audio", createWavBuffer(1), { filename: "clip.wav", contentType: "audio/wav" });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects clips longer than ten seconds based on parsed audio metadata", async () => {
    const response = await request(createApp())
      .post("/api/v1/reports/noise")
      .set("Authorization", `Bearer ${token}`)
      .field("latitude", "23.8103")
      .field("longitude", "90.4125")
      .attach("audio", createWavBuffer(11), { filename: "long-clip.wav", contentType: "audio/wav" });
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("AUDIO_TOO_LONG");
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects non-audio uploads before writing any file", async () => {
    const response = await request(createApp())
      .post("/api/v1/reports/noise")
      .set("Authorization", `Bearer ${token}`)
      .field("latitude", "23.8103")
      .field("longitude", "90.4125")
      .attach("audio", Buffer.from("not audio"), { filename: "notes.txt", contentType: "text/plain" });
    expect(response.status).toBe(415);
    expect(response.body.error.code).toBe("UNSUPPORTED_AUDIO_TYPE");
    expect(query).not.toHaveBeenCalled();
  });

  it("uses the ML decoder when browser WebM metadata has no duration", async () => {
    const reportId = "00000000-0000-4000-8000-000000000091";
    query.mockResolvedValueOnce({
      rows: [{
        id: reportId,
        latitude: 23.8103,
        longitude: 90.4125,
        status: "pending",
        predicted_class: null,
        confidence: null,
        db_level: null,
        mode: "stub",
        model_version: null,
        is_simulated: false,
        created_at: new Date("2026-01-02T03:04:05.000Z"),
        audio_path: "noise/browser-recording.webm",
      }],
      rowCount: 1,
    } as never);
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ duration_seconds: 6 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const storage: AudioStorage = {
      saveAudio: async () => "noise/browser-recording.webm",
      removeAudio: async () => undefined,
      readAudio: async () => Buffer.alloc(0),
    };
    const queue: NoiseReportJobQueue = {
      add: async (_name, data) => ({ id: data.reportId }),
    };

    try {
      const response = await request(createApp({
        noiseQueue: queue,
        audioStorage: storage,
        publishNoiseEvent: jest.fn(),
      }))
        .post("/api/v1/reports/noise")
        .set("Authorization", `Bearer ${token}`)
        .field("latitude", "23.8103")
        .field("longitude", "90.4125")
        .attach("audio", Buffer.from("browser-webm-without-duration-metadata"), {
          filename: "recording.webm",
          contentType: "audio/webm",
        });

      expect(response.status).toBe(202);
      expect(fetchMock).toHaveBeenCalledWith(
        `${config.ML_SERVICE_URL}/v1/noise/validate`,
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("stores an accepted clip privately, queues classification, and returns a safe summary", async () => {
    const reportId = "00000000-0000-4000-8000-000000000099";
    const reportRow = {
      id: reportId,
      latitude: 23.810346,
      longitude: 90.412567,
      status: "pending",
      predicted_class: null,
      confidence: null,
      db_level: null,
      mode: "stub",
      model_version: null,
      is_simulated: false,
      created_at: new Date("2026-01-02T03:04:05.000Z"),
      audio_path: "noise/private-audio.webm",
    };
    query.mockResolvedValueOnce({ rows: [reportRow], rowCount: 1 } as never);
    const addedJobs: string[] = [];
    const queue: NoiseReportJobQueue = {
      add: async (name, data) => {
        addedJobs.push(`${name}:${data.reportId}`);
        return { id: data.reportId };
      },
    };
    const storedKeys: string[] = [];
    const storage: AudioStorage = {
      saveAudio: async () => {
        storedKeys.push("noise/private-audio.webm");
        return "noise/private-audio.webm";
      },
      removeAudio: async () => undefined,
      readAudio: async () => Buffer.alloc(0),
    };
    const emitted: NoiseReportEvent[] = [];
    const response = await request(createApp({
      noiseQueue: queue,
      audioStorage: storage,
      publishNoiseEvent: (event) => emitted.push(event),
    }))
      .post("/api/v1/reports/noise")
      .set("Authorization", `Bearer ${token}`)
    .field("latitude", "23.810346")
    .field("longitude", "90.412567")
      .attach("audio", createWavBuffer(1), { filename: "clip.wav", contentType: "audio/wav" });

    expect(response.status).toBe(202);
    expect(response.body.jobId).toBe(reportId);
    expect(response.body.report).toMatchObject({
      id: reportId,
      status: "pending",
      latitude: 23.810346,
      longitude: 90.412567,
      mode: "stub",
      isSimulated: false,
    });
    expect(response.body.report).not.toHaveProperty("audio_path");
    expect(response.body.report).not.toHaveProperty("audioPath");
    expect(storedKeys).toEqual(["noise/private-audio.webm"]);
    expect(addedJobs).toEqual([`noise.classify:${reportId}`]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe("report:new");
    if (emitted[0]?.type === "report:new") {
      expect(emitted[0].report.latitude).toBe(23.8103);
      expect(emitted[0].report.longitude).toBe(90.4126);
      expect(emitted[0].report).not.toHaveProperty("audio_path");
    }
  });

  it("returns only public report fields from the map endpoint", async () => {
    query.mockResolvedValueOnce({
      rows: [{
        id: "00000000-0000-4000-8000-000000000098",
        latitude: "23.8103",
        longitude: "90.4125",
        status: "processed",
        predicted_class: "other",
        confidence: 0,
        db_level: null,
        mode: "stub",
        model_version: "noise-stub-v1",
        is_simulated: false,
        created_at: new Date("2026-01-02T03:04:05.000Z"),
        audio_path: "noise/private-audio.webm",
      }],
      rowCount: 1,
    } as never);
    const response = await request(createApp()).get("/api/v1/reports/noise");
    expect(response.status).toBe(200);
    expect(response.body.reports[0]).toMatchObject({
      latitude: 23.8103,
      longitude: 90.4125,
      predictedClass: "other",
      mode: "stub",
    });

    expect(response.body.reports[0]).not.toHaveProperty("audio_path");
    expect(response.body.reports[0]).not.toHaveProperty("audioPath");
  });

  it("includes the detailed analysis only in the authenticated report history", async () => {
    const analysis = { audio: { durationSeconds: 1 }, models: { neural: { available: false } } };
    query.mockResolvedValueOnce({
      rows: [{
        id: "00000000-0000-4000-8000-000000000092",
        latitude: "23.8103",
        longitude: "90.4125",
        status: "processed",
        predicted_class: "other",
        user_label: null,
        confidence: 0,
        db_level: 60,
        mode: "fallback",
        model_version: "noise-fallback-v1",
        analysis,
        is_simulated: false,
        created_at: new Date("2026-01-02T03:04:05.000Z"),
      }],
      rowCount: 1,
    } as never);

    const response = await request(createApp())
      .get("/api/v1/reports/noise/mine")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.reports[0].analysis).toEqual(analysis);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE user_id = $1"),
      [userId],
    );
  });

  it("deletes only an owned report and its private audio file", async () => {
    const reportId = "00000000-0000-4000-8000-000000000097";
    query
      .mockResolvedValueOnce({ rows: [{ audio_path: "noise/private-audio.webm" }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    const removedKeys: string[] = [];
    const storage: AudioStorage = {
      saveAudio: async () => "noise/private-audio.webm",
      removeAudio: async (key) => { removedKeys.push(key); },
      readAudio: async () => Buffer.alloc(0),
    };
    const events: NoiseReportEvent[] = [];
    const response = await request(createApp({
      audioStorage: storage,
      publishNoiseEvent: (event) => events.push(event),
    }))
      .delete(`/api/v1/reports/noise/${reportId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(204);
    expect(removedKeys).toEqual(["noise/private-audio.webm"]);
    expect(events).toEqual([{ type: "report:deleted", reportId }]);
  });

  it("does not remove audio when the report is not owned by the caller", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const storage: AudioStorage = {
      saveAudio: async () => "noise/private-audio.webm",
      removeAudio: jest.fn(async () => undefined),
      readAudio: async () => Buffer.alloc(0),
    };
    const reportId = "00000000-0000-4000-8000-000000000096";
    const response = await request(createApp({ audioStorage: storage }))
      .delete(`/api/v1/reports/noise/${reportId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("REPORT_NOT_FOUND");
    expect(storage.removeAudio).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("saves a corrected label only for the authenticated owner's processed report", async () => {
    const reportId = "00000000-0000-4000-8000-000000000095";
    query.mockResolvedValueOnce({
      rows: [{
        id: reportId,
        latitude: "23.8103",
        longitude: "90.4125",
        status: "processed",
        predicted_class: "other",
        user_label: "horn",
        confidence: 0.62,
        db_level: 71.4,
        mode: "classical",
        model_version: "noise-svm-v1",
        is_simulated: false,
        created_at: new Date("2026-01-02T03:04:05.000Z"),
      }],
      rowCount: 1,
    } as never);

    const response = await request(createApp())
      .patch(`/api/v1/reports/noise/${reportId}/label`)
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "horn" });

    expect(response.status).toBe(200);
    expect(response.body.report).toMatchObject({ id: reportId, predictedClass: "other", userLabel: "horn" });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE id = $1 AND user_id = $2 AND status = 'processed'"),
      [reportId, userId, "horn"],
    );
  });

  it("does not disclose or update a label for another user's report", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const reportId = "00000000-0000-4000-8000-000000000094";
    const response = await request(createApp())
      .patch(`/api/v1/reports/noise/${reportId}/label`)
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "siren" });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("REPORT_NOT_FOUND");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects labels outside the supported noise classes", async () => {
    const response = await request(createApp())
      .patch("/api/v1/reports/noise/00000000-0000-4000-8000-000000000093/label")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "aircraft" });

    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
