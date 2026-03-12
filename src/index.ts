import { Router, Request, Response, NextFunction } from "express";
import { ModrinthService } from "./modrinth";
import { UIService } from "./ui";

export const CONFIG = {
  MODRINTH_API_BASE: "https://api.modrinth.com/v2",
  USER_AGENT: "AirLink-ModrinthAddon/1.0",
  CACHE_DURATION: 30 * 60 * 1000,
  MAX_FILE_SIZE: 100 * 1024 * 1024,
  SEARCH_LIMIT: 20,
} as const;

async function setupDatabase(prisma: any, logger: any): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ModrinthCache (
      cacheKey TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expiresAt DATETIME NOT NULL
    )
  `);

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

  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_modrinth_status ON ModrinthInstallation(status)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_modrinth_project ON ModrinthInstallation(projectId, status)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_modrinth_server ON ModrinthInstallation(serverId)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_modrinth_installed_at ON ModrinthInstallation(installedAt)`);

  logger.info("Modrinth database schema ready");
}

export default async (router: Router, api: any) => {
  const { logger, prisma } = api;

  router.use((req: Request, _res: Response, next: NextFunction) => {
    req.__prisma = prisma;
    next();
  });

  await setupDatabase(prisma, logger);

  const modrinthService = new ModrinthService(prisma, logger, CONFIG);
  const uiService = new UIService(api);

  modrinthService.setupRoutes(router, api, uiService);
  uiService.setupUI();
  uiService.setupRoutes(router, modrinthService);

  setInterval(() => uiService.cleanupOldStatistics().catch(() => {}), 24 * 60 * 60 * 1000);

  logger.info("Modrinth addon initialized");
};
