import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app";
import { config } from "../src/config";

describe("API health and request validation", () => {
  const app = createApp();

  it("reports liveness without requiring database access", async () => {
    const response = await request(app).get("/health/live");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("returns a consistent validation error for invalid registration", async () => {
    const response = await request(app).post("/api/v1/auth/register").send({ email: "not-an-email" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns a consistent not-found error", async () => {
    const response = await request(app).get("/api/v1/not-a-route");
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it.each(["http://localhost:5173", "http://127.0.0.1:5173"])(
    "allows the local web origin %s for API preflight requests",
    async (origin) => {
      const response = await request(app)
        .options("/api/v1/auth/register")
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "content-type");

      expect(response.status).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
    },
  );

  it("does not allow unrelated browser origins", async () => {
    const response = await request(app)
      .options("/api/v1/auth/register")
      .set("Origin", "http://example.invalid")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("denies citizen access to an admin-only endpoint", async () => {
    const token = jwt.sign(
      { role: "citizen", type: "access" },
      config.JWT_ACCESS_SECRET,
      { subject: "00000000-0000-4000-8000-000000000001", expiresIn: "1m" },
    );
    const response = await request(app)
      .get("/api/v1/admin/access-check")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});
