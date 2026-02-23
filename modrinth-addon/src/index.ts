/**
 * =============================================================================
 * File: index.ts
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

import { Router, Request, Response, NextFunction } from "express";
import { ModrinthService } from "./modrinth";
import { UIService } from "./ui";

// =============================================================================
// CONFIGURATION
// =============================================================================
const CONFIG = {
  MODRINTH_API_BASE: "https://api.modrinth.com/v2",
  USER_AGENT: "AirLink-ModrinthAddon/1.0",
  CACHE_DURATION: 30 * 60 * 1000, // 30 minutes
  MAX_FILE_SIZE: 100 * 1024 * 1024, // 100MB
  SEARCH_LIMIT: 20,
} as const;

// =============================================================================
// EXTEND EXPRESS REQUEST
// =============================================================================
declare global {
  namespace Express {
    interface Request {
      __prisma?: any;
    }
  }
}

// =============================================================================
// CACHE TABLE CREATION
// =============================================================================
async function ensureCacheTables(prisma: any, logger: any): Promise<void> {
  try {
    // Create cache table
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ModrinthCache (
        cacheKey TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expiresAt DATETIME NOT NULL
      )
    `);

    // Create SINGLE installations table with proper schema
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ModrinthInstallation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        projectId TEXT NOT NULL,
        projectType TEXT NOT NULL,
        projectName TEXT,
        versionId TEXT,
        serverId TEXT,
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'blocked', 'in_progress')),
        error TEXT,
        installedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for better performance
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_modrinth_status ON ModrinthInstallation(status)
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_modrinth_project ON ModrinthInstallation(projectId, status)
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_modrinth_server ON ModrinthInstallation(serverId)
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_modrinth_installed_at ON ModrinthInstallation(installedAt)
    `);

    logger.info("✅ Modrinth database schema initialized");

    // Test the table exists
    const testResult = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*) as count FROM ModrinthInstallation
    `);
    //    logger.info(`📊 Found ${testResult[0]?.count || 0} existing installation records`);
  } catch (error) {
    logger.error("❌ Failed to initialize Modrinth database schema:", error);
    throw error;
  }
}
// =============================================================================
// MAIN EXPORT
// =============================================================================
export default async (router: Router, api: any) => {
  const { logger, prisma } = api;

  // Attach prisma to all requests
  router.use((req: Request, _res: Response, next: NextFunction) => {
    req.__prisma = prisma;
    next();
  });

  // Ensure cache tables exist before starting
  await ensureCacheTables(prisma, logger);

  // Initialize services
  const modrinthService = new ModrinthService(prisma, logger, CONFIG);
  const uiService = new UIService(api);

  // Backend API routes (data, installs, etc.)
  modrinthService.setupRoutes(router, api, uiService);

  // UI setup (sidebar + server menu items)
  uiService.setupUI();

  // Frontend UI pages (browse, project detail)
  uiService.setupRoutes(router, modrinthService);

  logger.info("✅ Modrinth addon initialized");
};

export { CONFIG };

// Debugging helper function
export async function debugStatistics(prisma: any, logger: any): Promise<void> {
  try {
    // Check what tables exist
    const tables = await prisma.$queryRawUnsafe(`
      SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%Modrinth%'
    `);
    logger.info("Existing Modrinth tables:", tables);

    // Check table schema
    if (tables.some((t: any) => t.name === "ModrinthInstallation")) {
      const schema = await prisma.$queryRawUnsafe(`
        PRAGMA table_info(ModrinthInstallation)
      `);
      logger.info("ModrinthInstallation schema:", schema);

      // Get sample data
      const sampleData = await prisma.$queryRawUnsafe(`
        SELECT * FROM ModrinthInstallation ORDER BY id DESC LIMIT 5
      `);
      logger.info("Sample installation data:", sampleData);

      // Get counts by status
      const statusCounts = await prisma.$queryRawUnsafe(`
        SELECT status, COUNT(*) as count FROM ModrinthInstallation GROUP BY status
      `);
      logger.info("Status counts:", statusCounts);
    }
  } catch (error) {
    logger.error("Debug statistics error:", error);
  }
}
