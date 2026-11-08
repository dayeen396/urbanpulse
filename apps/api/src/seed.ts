import bcrypt from "bcryptjs";
import { pool } from "./db";

async function seed(): Promise<void> {
  const { SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD } = process.env;
  if (!SEED_ADMIN_EMAIL && !SEED_ADMIN_PASSWORD) {
    console.log("No admin credentials provided; seed skipped.");
    return;
  }
  if (!SEED_ADMIN_EMAIL || !SEED_ADMIN_PASSWORD || SEED_ADMIN_PASSWORD.length < 10) {
    throw new Error("Set both SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (at least 10 characters).");
  }

  const email = SEED_ADMIN_EMAIL.toLowerCase();
  const passwordHash = await bcrypt.hash(SEED_ADMIN_PASSWORD, 12);
  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, role)
     VALUES ($1, $2, 'UrbanPulse Admin', 'admin')
     ON CONFLICT (email) DO NOTHING`,
    [email, passwordHash],
  );
  console.log(`Admin account ensured for ${email}.`);
}

seed()
  .catch((error: unknown) => {
    console.error("Seed failed", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
