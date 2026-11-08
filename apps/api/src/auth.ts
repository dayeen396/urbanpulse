import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { NextFunction, Request, Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { z } from "zod";
import { config } from "./config";
import { pool } from "./db";
import { HttpError } from "./errors";

const credentialsSchema = z.object({
  email: z.string().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(10).max(128),
});

const registerSchema = credentialsSchema.extend({
  displayName: z.string().trim().min(1).max(80),
});

type UserRole = "citizen" | "official" | "admin";

export interface AuthenticatedRequest extends Request {
  auth?: { userId: string; role: UserRole };
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  password_hash: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createTokens(user: Pick<UserRow, "id" | "role">): { accessToken: string; refreshToken: string; refreshId: string } {
  const refreshId = randomUUID();
  const accessToken = jwt.sign({ role: user.role, type: "access" }, config.JWT_ACCESS_SECRET, {
    subject: user.id,
    expiresIn: "15m",
  });
  const refreshToken = jwt.sign({ type: "refresh" }, config.JWT_REFRESH_SECRET, {
    subject: user.id,
    jwtid: refreshId,
    expiresIn: "7d",
  });
  return { accessToken, refreshToken, refreshId };
}

async function saveRefreshToken(userId: string, token: string): Promise<void> {
  const payload = jwt.decode(token) as JwtPayload | null;
  if (!payload?.exp) throw new Error("Generated refresh token is missing an expiry");
  await pool.query(
    "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, to_timestamp($3))",
    [userId, hashToken(token), payload.exp],
  );
}

function publicUser(user: UserRow): Omit<UserRow, "password_hash"> {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
  };
}

export async function register(emailValue: unknown, passwordValue: unknown, displayNameValue: unknown) {
  const input = registerSchema.parse({ email: emailValue, password: passwordValue, displayName: displayNameValue });
  const passwordHash = await bcrypt.hash(input.password, 12);
  let result;
  try {
    result = await pool.query<UserRow>(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, role, password_hash`,
      [input.email, passwordHash, input.displayName],
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      throw new HttpError(409, "An account with this email already exists", "EMAIL_ALREADY_REGISTERED");
    }
    throw error;
  }
  const user = result.rows[0];
  if (!user) throw new Error("User registration returned no row");
  const tokens = createTokens(user);
  await saveRefreshToken(user.id, tokens.refreshToken);
  return { user: publicUser(user), accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

export async function login(emailValue: unknown, passwordValue: unknown) {
  const input = credentialsSchema.parse({ email: emailValue, password: passwordValue });
  const result = await pool.query<UserRow>(
    "SELECT id, email, display_name, role, password_hash FROM users WHERE email = $1",
    [input.email],
  );
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(input.password, user.password_hash))) {
    throw new HttpError(401, "Invalid email or password", "INVALID_CREDENTIALS");
  }
  const tokens = createTokens(user);
  await saveRefreshToken(user.id, tokens.refreshToken);
  return { user: publicUser(user), accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

export async function refresh(refreshTokenValue: unknown) {
  const token = z.string().min(1).parse(refreshTokenValue);
  let payload: JwtPayload;
  try {
    const verified = jwt.verify(token, config.JWT_REFRESH_SECRET);
    if (typeof verified === "string" || verified.type !== "refresh" || !verified.sub) {
      throw new Error("Invalid refresh token claims");
    }
    payload = verified;
  } catch {
    throw new HttpError(401, "Invalid or expired refresh token", "INVALID_REFRESH_TOKEN");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ user_id: string }>(
      `UPDATE refresh_tokens SET revoked_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [hashToken(token)],
    );
    const row = result.rows[0];
    if (!row || row.user_id !== payload.sub) {
      await client.query("ROLLBACK");
      throw new HttpError(401, "Refresh token has been revoked or expired", "INVALID_REFRESH_TOKEN");
    }
    const userResult = await client.query<UserRow>(
      "SELECT id, email, display_name, role, password_hash FROM users WHERE id = $1",
      [row.user_id],
    );
    const user = userResult.rows[0];
    if (!user) {
      await client.query("ROLLBACK");
      throw new HttpError(401, "User no longer exists", "INVALID_REFRESH_TOKEN");
    }
    const tokens = createTokens(user);
    const newPayload = jwt.decode(tokens.refreshToken) as JwtPayload | null;
    if (!newPayload?.exp) throw new Error("Generated refresh token is missing an expiry");
    await client.query(
      "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, to_timestamp($3))",
      [user.id, hashToken(tokens.refreshToken), newPayload.exp],
    );
    await client.query("COMMIT");
    return { user: publicUser(user), accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  } catch (error) {
    await client.query("ROLLBACK").catch((rollbackError: unknown) => {
      console.error("Failed to roll back refresh token transaction", rollbackError);
    });
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeRefreshToken(refreshTokenValue: unknown): Promise<void> {
  const token = z.string().min(1).parse(refreshTokenValue);
  await pool.query(
    "UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
    [hashToken(token)],
  );
}

export function authenticate(request: AuthenticatedRequest, _response: Response, next: NextFunction): void {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    next(new HttpError(401, "Authentication required", "UNAUTHENTICATED"));
    return;
  }
  try {
    const payload = jwt.verify(authorization.slice(7), config.JWT_ACCESS_SECRET);
    if (typeof payload === "string" || payload.type !== "access" || !payload.sub) {
      throw new Error("Invalid access token claims");
    }
    if (payload.role !== "citizen" && payload.role !== "official" && payload.role !== "admin") {
      throw new Error("Invalid user role");
    }
    request.auth = { userId: payload.sub, role: payload.role };
    next();
  } catch {
    next(new HttpError(401, "Invalid or expired access token", "INVALID_ACCESS_TOKEN"));
  }
}

export function requireRoles(...roles: UserRole[]) {
  return (request: AuthenticatedRequest, _response: Response, next: NextFunction): void => {
    if (!request.auth) {
      next(new HttpError(401, "Authentication required", "UNAUTHENTICATED"));
      return;
    }
    if (!roles.includes(request.auth.role)) {
      next(new HttpError(403, "Insufficient permissions", "FORBIDDEN"));
      return;
    }
    next();
  };
}
