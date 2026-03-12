import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

const projectRoot = path.resolve(__dirname, '../..');
const envPath = path.join(projectRoot, '.env');

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  console.warn(`[Parachute] .env not found at ${envPath}`);
}

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim() ?? '';
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
export const APP_URL = process.env.APP_URL?.trim() ?? 'http://localhost:3000';
export const PARACHUTE_COOKIE_SECRET = process.env.PARACHUTE_COOKIE_SECRET ?? 'default_secret_change_me';

export function validateConfig(): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
  if (!GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
  if (!APP_URL) missing.push('APP_URL');
  return { valid: missing.length === 0, missing };
}
