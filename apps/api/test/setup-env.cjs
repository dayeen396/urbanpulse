globalThis.process.env.DATABASE_URL = "postgres://test:test@localhost:5432/urbanpulse_test";
globalThis.process.env.REDIS_URL = "redis://localhost:6379";
globalThis.process.env.JWT_ACCESS_SECRET = "test-only-access-secret-not-for-deployment";
globalThis.process.env.JWT_REFRESH_SECRET = "test-only-refresh-secret-not-for-deployment";
globalThis.process.env.CORS_ORIGIN = "http://localhost:5173,http://127.0.0.1:5173";
