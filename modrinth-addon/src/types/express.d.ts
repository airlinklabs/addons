/**
 * =============================================================================
 * File: express.d.ts
 * Author: g-flame
 * =============================================================================
 *
 * CREDITS:
 * - Addon developed by g-flame
 * - Panel by AirlinkLabs
 * - Special thanks to Modrinth for platform and API
 * - Thanks to all contributors
 *
 * NOTES:
 * - This file is part of the Airlink Addons – Modrinth Store project
 * - All TypeScript logic written by g-flame
 *
 * =============================================================================
 */
import { ApiKey } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      apiKey?: ApiKey;
      session?: {
        user?: {
          id: string;
          username: string;
          email: string;
          isAdmin?: boolean;
        };
      } & Express.Session;
    }
  }
}

export {};
