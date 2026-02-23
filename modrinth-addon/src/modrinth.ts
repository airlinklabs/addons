/**
 * =============================================================================
 * File: modrinth.ts
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
import path from "path";
import axios from "axios";
import { BackendLogic } from "./handlers/backend-logic";
import { ModpackInstaller } from "./handlers/installer";
import {
  AddonAPI,
  ModrinthProject,
  ModrinthVersion,
  ServerData,
} from "./types/types";
import { UIService } from "./ui";
import { progressTracker } from "./handlers/progress-tracker";
export let uiService: UIService;

const multer = require("multer");

// Initialize statistics schema
async function initializeStatisticsSchema(
  prisma: any,
  logger: any
): Promise<void> {
  try {
    // Create the statistics table if it doesn't exist
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS ModrinthInstallations (
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
    `;

    // Create indexes for better performance
    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS idx_modrinth_status ON ModrinthInstallation(status)
    `;
    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS idx_modrinth_project ON ModrinthInstallation(projectId, status)  
    `;
    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS idx_modrinth_server ON ModrinthInstallation(serverId)
    `;
    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS idx_modrinth_installed_at ON ModrinthInstallation(installedAt)
    `;

    logger.info("✅ Modrinth statistics database schema initialized");

    // Test the statistics functionality
    const testStats = await prisma.$queryRaw`
      SELECT COUNT(*) as count FROM ModrinthInstallations
    `;
    logger.info(
      `📊 Found ${testStats[0]?.count || 0} existing installation records`
    );
  } catch (error) {
    logger.error("❌ Failed to initialize Modrinth statistics schema:", error);
  }
}

// Utility function to migrate existing data if needed
async function migrateExistingInstallationData(
  prisma: any,
  logger: any
): Promise<void> {
  try {
    // Check if old table exists with different name
    const oldTableExists = await prisma.$queryRaw`
      SELECT name FROM sqlite_master WHERE type='table' AND name='ModrinthInstallations'
    `;

    if (Array.isArray(oldTableExists) && oldTableExists.length > 0) {
      logger.info("Found old ModrinthInstallations table, migrating data...");

      // Copy data from old table to new table
      await prisma.$executeRaw`
        INSERT INTO ModrinthInstallations (projectId, projectType, serverId, status, installedAt)
        SELECT 
          projectId, 
          COALESCE(projectType, 'unknown') as projectType,
          serverId, 
          status, 
          COALESCE(installedAt, CURRENT_TIMESTAMP) as installedAt
        FROM ModrinthInstallations
        WHERE NOT EXISTS (
          SELECT 1 FROM ModrinthInstallations 
          WHERE ModrinthInstallations.projectId = ModrinthInstallations.projectId 
          AND ModrinthInstallations.serverId = ModrinthInstallations.serverId
        )
      `;

      const migratedCount = await prisma.$queryRaw`
        SELECT COUNT(*) as count FROM ModrinthInstallations
      `;

      logger.info(
        `✅ Migrated ${migratedCount[0]?.count || 0} installation records`
      );

      // Optionally drop the old table after successful migration
      // await prisma.$executeRaw`DROP TABLE ModrinthInstallations`;
      // logger.info('✅ Removed old ModrinthInstallations table');
    }
  } catch (error) {
    logger.warn(
      "Data migration failed, but continuing with new schema:",
      error
    );
  }
}

export function setupModrinth(api: AddonAPI) {
  const router = Router();

  // Initialize services
  const modrinthService = new ModrinthService(api.prisma, api.logger, {});
  const uiService = new UIService(api);

  // Initialize database schema and migrate existing data
  Promise.resolve()
    .then(() => initializeStatisticsSchema(api.prisma, api.logger))
    .then(() => migrateExistingInstallationData(api.prisma, api.logger))
    .catch((error) =>
      api.logger.error("Database initialization failed:", error)
    );

  // Rest of setup...
  uiService.setupUI();
  uiService.setupRoutes(router, modrinthService);
  modrinthService.setupRoutes(router, api, uiService);

  // Setup periodic cleanup
  setInterval(async () => {
    try {
      await uiService.cleanupOldStatistics();
    } catch (error) {
      api.logger.warn("Statistics cleanup failed:", error);
    }
  }, 24 * 60 * 60 * 1000);

  api.registerRoute("/modrinth", router);
  api.logger.info("✅ Modrinth addon registered with statistics");
}
const isAuthenticatedForServer = (serverIdParam: string = "id") => {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const prisma = (req as any).__prisma || (global as any).__addonPrisma;

    if (!prisma) {
      res.status(500).json({ error: "Database connection not available" });
      return;
    }

    const userId = req.session?.user?.id;
    if (!userId) {
      if (req.path.startsWith("/api/")) {
        res
          .status(401)
          .json({ success: false, error: "Authentication required" });
        return;
      }
      res.redirect("/login");
      return;
    }

    try {
      const user = await prisma.users.findUnique({ where: { id: userId } });
      if (!user) {
        if (req.path.startsWith("/api/")) {
          res.status(401).json({ success: false, error: "User not found" });
          return;
        }
        res.redirect("/login");
        return;
      }

      if (user.isAdmin) {
        next();
        return;
      }

      const serverId = req.params[serverIdParam];
      if (!serverId) {
        res.status(400).json({ success: false, error: "Server ID required" });
        return;
      }

      const server = await prisma.server.findUnique({
        where: { UUID: serverId },
        include: { owner: true },
      });

      if (!server) {
        res.status(404).json({ success: false, error: "Server not found" });
        return;
      }

      if (server.ownerId === userId) {
        next();
        return;
      }

      if (req.path.startsWith("/api/")) {
        res.status(403).json({ success: false, error: "Access denied" });
        return;
      }
      res.redirect("/");
    } catch (error) {
      console.error("Auth middleware error:", error);
      if (req.path.startsWith("/api/")) {
        res.status(500).json({ success: false, error: "Authentication error" });
        return;
      }
      res.redirect("/");
    }
  };
};

async function checkForServerInstallation(
  serverId: string,
  prisma?: any
): Promise<boolean> {
  try {
    if (!prisma || !serverId) return true;
    const server = await prisma.server.findUnique({
      where: { UUID: serverId },
    });
    return !!server;
  } catch (error) {
    return true;
  }
}

export class ModrinthService {
  private prisma: any;
  private logger: any;
  private config: any;
  private upload: any;
  private backendLogic: BackendLogic;
  private installer: ModpackInstaller;
  private activeInstallations: Map<string, boolean> = new Map();

  constructor(prisma: any, logger: any, config: any) {
    this.prisma = prisma;
    this.logger = logger;
    this.config = {
      CACHE_DURATION: 10 * 60 * 1000, // 10 minutes
      SEARCH_LIMIT: 20,
      MAX_FILE_SIZE: 500 * 1024 * 1024, // 500MB
      MODRINTH_API_BASE: "https://api.modrinth.com/v2",
      USER_AGENT: "Modrinth-Addon/1.0.0",
      MAX_CONCURRENT_DOWNLOADS: 3,
      DOWNLOAD_TIMEOUT: 300000, // 5 minutes
      RETRY_ATTEMPTS: 3,
      RETRY_DELAY: 2000,
      ALLOWED_FILE_TYPES: [".mrpack", ".zip", ".jar"],
      ...config,
    };

    this.backendLogic = new BackendLogic(logger, this.config);
    this.installer = new ModpackInstaller(prisma, logger, this.config);

    this.upload = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: this.config.MAX_FILE_SIZE,
        files: 1,
      },
      fileFilter: (req: any, file: any, cb: any) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const isValid = this.config.ALLOWED_FILE_TYPES.includes(ext);

        if (!isValid) {
          cb(
            new Error(
              `Invalid file type. Allowed types: ${this.config.ALLOWED_FILE_TYPES.join(
                ", "
              )}`
            )
          );
        } else {
          cb(null, true);
        }
      },
    });
  }

  // Cache management
  async getCachedData(cacheKey: string): Promise<any> {
    try {
      if (!this.prisma || !cacheKey || typeof cacheKey !== "string")
        return null;

      const cached = await this.prisma.$queryRaw`
        SELECT data FROM ModrinthCache 
        WHERE cacheKey = ${cacheKey} AND expiresAt > datetime('now')
        LIMIT 1
      `;

      if (Array.isArray(cached) && cached.length > 0 && cached[0]?.data) {
        return JSON.parse(cached[0].data);
      }
      return null;
    } catch (error) {
      this.logger?.warn("Cache read error:", error);
      return null;
    }
  }

  async setCachedData(
    cacheKey: string,
    data: any,
    duration: number = this.config.CACHE_DURATION
  ): Promise<void> {
    try {
      if (!this.prisma || !cacheKey || !data || typeof cacheKey !== "string")
        return;

      const expiresAt = new Date(Date.now() + duration).toISOString();
      const dataStr = JSON.stringify(data);

      // Limit cache entry size to prevent issues
      if (dataStr.length > 10 * 1024 * 1024) {
        // 10MB limit
        this.logger?.warn("Cache entry too large, skipping:", cacheKey);
        return;
      }

      await this.prisma.$executeRaw`
        INSERT OR REPLACE INTO ModrinthCache (cacheKey, data, expiresAt) 
        VALUES (${cacheKey}, ${dataStr}, ${expiresAt})
      `;
    } catch (error) {
      this.logger?.warn("Cache write error:", error);
    }
  }

  async clearExpiredCache(): Promise<void> {
    try {
      if (!this.prisma) return;

      await this.prisma.$executeRaw`
        DELETE FROM ModrinthCache WHERE expiresAt <= datetime('now')
      `;
    } catch (error) {
      this.logger?.warn("Cache cleanup error:", error);
    }
  }

  // Modrinth API methods
  async makeModrinthRequest(endpoint: string, params?: any): Promise<any> {
    if (!endpoint || typeof endpoint !== "string") {
      throw new Error("Invalid endpoint");
    }

    // Clean up expired cache entries periodically
    if (Math.random() < 0.01) {
      // 1% chance
      this.clearExpiredCache().catch(() => {});
    }

    const cacheKey = `modrinth:${endpoint}:${JSON.stringify(params || {})}`;
    const cached = await this.getCachedData(cacheKey);
    if (cached) {
      this.logger?.debug(`Cache hit for: ${endpoint}`);
      return cached;
    }

    let attempt = 0;
    let lastError: any;

    while (attempt < this.config.RETRY_ATTEMPTS) {
      try {
        this.logger?.debug(`API request (attempt ${attempt + 1}): ${endpoint}`);

        const response = await axios.get(
          `${this.config.MODRINTH_API_BASE}${endpoint}`,
          {
            params,
            headers: {
              "User-Agent": this.config.USER_AGENT,
              Accept: "application/json",
            },
            timeout: 30000,
            validateStatus: (status) => status < 500, // Don't retry 4xx errors
          }
        );

        if (response.status >= 400) {
          throw new Error(
            `API returned status ${response.status}: ${response.statusText}`
          );
        }

        await this.setCachedData(cacheKey, response.data);
        this.logger?.debug(`API success: ${endpoint}`);
        return response.data;
      } catch (error: any) {
        lastError = error;
        attempt++;

        // Don't retry 4xx errors
        if (
          error.response &&
          error.response.status >= 400 &&
          error.response.status < 500
        ) {
          throw error;
        }

        if (attempt >= this.config.RETRY_ATTEMPTS) {
          this.logger?.error(
            `API request failed after ${attempt} attempts: ${endpoint}`,
            error.message
          );
          throw error;
        }

        const delay = this.config.RETRY_DELAY * Math.pow(2, attempt - 1);
        this.logger?.warn(
          `API retry ${attempt} in ${delay}ms: ${endpoint}`,
          error.message
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  async searchModrinth(query: string, type: string = "all", page: number = 1) {
    try {
      const params: any = {
        query: query?.trim() || "",
        offset: Math.max(0, (page - 1) * this.config.SEARCH_LIMIT),
        limit: Math.min(this.config.SEARCH_LIMIT, 100), // Cap at 100
        index: "relevance",
      };

      if (
        type &&
        type !== "all" &&
        ["mod", "modpack", "resourcepack", "shader"].includes(type)
      ) {
        params.facets = JSON.stringify([[`project_type:${type}`]]);
      }

      const result = await this.makeModrinthRequest("/search", params);
      return {
        hits: result.hits || [],
        total_hits: result.total_hits || 0,
        offset: result.offset || 0,
        limit: result.limit || this.config.SEARCH_LIMIT,
      };
    } catch (error: any) {
      this.logger?.error("Search failed:", error.message);
      return {
        hits: [],
        total_hits: 0,
        offset: 0,
        limit: this.config.SEARCH_LIMIT,
      };
    }
  }

  async getProject(projectId: string): Promise<ModrinthProject> {
    if (!projectId || typeof projectId !== "string") {
      throw new Error("Project ID is required");
    }

    const sanitizedId = projectId.trim();
    if (sanitizedId.length === 0) {
      throw new Error("Invalid project ID");
    }

    return await this.makeModrinthRequest(
      `/project/${encodeURIComponent(sanitizedId)}`
    );
  }

  async getProjectVersions(projectId: string): Promise<ModrinthVersion[]> {
    if (!projectId || typeof projectId !== "string") {
      throw new Error("Project ID is required");
    }

    const sanitizedId = projectId.trim();
    if (sanitizedId.length === 0) {
      throw new Error("Invalid project ID");
    }

    return await this.makeModrinthRequest(
      `/project/${encodeURIComponent(sanitizedId)}/version`
    );
  }

  // Installation management
  private getInstallationKey(serverId: string, versionId?: string): string {
    return versionId ? `${serverId}:${versionId}` : serverId;
  }

  private isInstallationInProgress(
    serverId: string,
    versionId?: string
  ): boolean {
    const key = this.getInstallationKey(serverId, versionId);
    return this.activeInstallations.has(key);
  }

  private setInstallationInProgress(
    serverId: string,
    versionId?: string
  ): void {
    const key = this.getInstallationKey(serverId, versionId);
    this.activeInstallations.set(key, true);
  }

  private clearInstallationInProgress(
    serverId: string,
    versionId?: string
  ): void {
    const key = this.getInstallationKey(serverId, versionId);
    this.activeInstallations.delete(key);
  }

  // Installation methods
  async installModpack(
    serverId: string,
    projectId: string,
    versionId: string,
    uiService?: UIService
  ): Promise<void> {
    const installKey = this.getInstallationKey(serverId, versionId);

    if (this.isInstallationInProgress(serverId, versionId)) {
      throw new Error(
        "Installation already in progress for this server/version"
      );
    }

    this.setInstallationInProgress(serverId, versionId);

    // Get project details for logging
    let projectName = "";
    let projectType = "";

    try {
      const project = await this.getProject(projectId);
      projectName = project.title || projectId;
      projectType = project.project_type || "unknown";

      // Log installation start
      if (uiService) {
        await uiService.logInstallationAttempt(
          projectId,
          projectType,
          "in_progress",
          serverId,
          projectName,
          versionId
        );
      }

      // Perform the actual installation
      await this.installer.installModpack(
        serverId,
        projectId,
        versionId,
        this.getCachedData.bind(this),
        this.setCachedData.bind(this),
        this.makeModrinthRequest.bind(this)
      );

      // Log successful completion
      if (uiService) {
        await uiService.updateInstallationStatus(
          projectId,
          versionId,
          serverId,
          "completed"
        );
      }
      /*
      this.logger?.info('Modpack installation completed:', {
        projectId, 
        projectName, 
        serverId
      });
      */
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown installation error";

      // Log failed installation
      if (uiService) {
        await uiService.updateInstallationStatus(
          projectId,
          versionId,
          serverId,
          "failed",
          errorMessage
        );
      }

      this.logger?.error("Modpack installation failed:", {
        projectId,
        serverId,
        error: errorMessage,
      });

      throw error;
    } finally {
      this.clearInstallationInProgress(serverId, versionId);
    }
  }

  async installMrpack(
    server: any,
    mrpackBuffer: Buffer,
    uiService?: UIService
  ): Promise<void> {
    if (this.isInstallationInProgress(server.UUID)) {
      throw new Error("Installation already in progress for this server");
    }

    this.setInstallationInProgress(server.UUID);

    try {
      // Log mrpack installation start
      if (uiService) {
        await uiService.logInstallationAttempt(
          "mrpack-upload",
          "modpack",
          "in_progress",
          server.UUID,
          "Uploaded Modpack"
        );
      }

      await this.installer.installMrpack(
        server,
        mrpackBuffer,
        this.getCachedData.bind(this),
        this.setCachedData.bind(this)
      );

      // Log successful completion
      if (uiService) {
        await uiService.updateInstallationStatus(
          "mrpack-upload",
          "upload",
          server.UUID,
          "completed"
        );
      }

      this.logger?.info("Mrpack installation completed:", {
        serverId: server.UUID,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown mrpack installation error";

      // Log failed installation
      if (uiService) {
        await uiService.updateInstallationStatus(
          "mrpack-upload",
          "upload",
          server.UUID,
          "failed",
          errorMessage
        );
      }

      this.logger?.error("Mrpack installation failed:", {
        serverId: server.UUID,
        error: errorMessage,
      });

      throw error;
    } finally {
      this.clearInstallationInProgress(server.UUID);
    }
  }

  async installZipFile(
    server: any,
    zipBuffer: Buffer,
    uiService?: UIService
  ): Promise<void> {
    if (this.isInstallationInProgress(server.UUID)) {
      throw new Error("Installation already in progress for this server");
    }

    this.setInstallationInProgress(server.UUID);

    try {
      // Log zip installation start
      if (uiService) {
        await uiService.logInstallationAttempt(
          "zip-upload",
          "modpack",
          "in_progress",
          server.UUID,
          "Uploaded ZIP"
        );
      }

      await this.installer.installZipFile(server, zipBuffer);

      // Log successful completion
      if (uiService) {
        await uiService.updateInstallationStatus(
          "zip-upload",
          "upload",
          server.UUID,
          "completed"
        );
      }

      this.logger?.info("ZIP installation completed:", {
        serverId: server.UUID,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown ZIP installation error";

      // Log failed installation
      if (uiService) {
        await uiService.updateInstallationStatus(
          "zip-upload",
          "upload",
          server.UUID,
          "failed",
          errorMessage
        );
      }

      this.logger?.error("ZIP installation failed:", {
        serverId: server.UUID,
        error: errorMessage,
      });

      throw error;
    } finally {
      this.clearInstallationInProgress(server.UUID);
    }
  }

  // Validation helpers
  private validateServerId(serverId: string): void {
    if (
      !serverId ||
      typeof serverId !== "string" ||
      serverId.trim().length === 0
    ) {
      throw new Error("Valid server ID is required");
    }
  }

  private validateProjectData(projectId: string, versionId: string): void {
    if (
      !projectId ||
      typeof projectId !== "string" ||
      projectId.trim().length === 0
    ) {
      throw new Error("Valid project ID is required");
    }
    if (
      !versionId ||
      typeof versionId !== "string" ||
      versionId.trim().length === 0
    ) {
      throw new Error("Valid version ID is required");
    }
  }

  // API Routes only
  setupRoutes(router: Router, _api: AddonAPI, uiService: UIService): void {
    // Search API
    router.get("/api/search", async (req: Request, res: Response) => {
      try {
        const query = String(req.query.q || "").trim();
        const type = String(req.query.type || "all").trim();
        const page = Math.max(1, parseInt(req.query.page as string) || 1);

        // Input validation
        if (query.length > 100) {
          return res
            .status(400)
            .json({ success: false, error: "Query too long" });
        }

        const results = await this.searchModrinth(query, type, page);
        res.json({ success: true, data: results });
      } catch (error: any) {
        this.logger?.error("Search API error:", error);
        res.status(500).json({ success: false, error: "Search failed" });
      }
    });

    // Project API
    router.get("/api/project/:id", async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        if (!id || typeof id !== "string") {
          return res
            .status(400)
            .json({ success: false, error: "Project ID is required" });
        }

        const projectId = id.trim();
        if (projectId.length === 0 || projectId.length > 100) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid project ID" });
        }

        const [project, versions] = await Promise.all([
          this.getProject(projectId),
          this.getProjectVersions(projectId),
        ]);

        res.json({ success: true, data: { project, versions } });
      } catch (error: any) {
        this.logger?.error("Project API error:", error);
        if (error.response?.status === 404) {
          res.status(404).json({ success: false, error: "Project not found" });
        } else {
          res
            .status(500)
            .json({ success: false, error: "Failed to get project details" });
        }
      }
    });

    // Install API (with proper authentication)
    router.post(
      "/api/install",
      isAuthenticatedForServer("serverId"),
      async (req: Request, res: Response) => {
        try {
          const { serverId, projectId, versionId } = req.body;

          this.validateServerId(serverId);
          this.validateProjectData(projectId, versionId);

          if (this.isInstallationInProgress(serverId, versionId)) {
            return res.status(409).json({
              success: false,
              error: "Installation already in progress",
            });
          }

          // Check if project is blocked before starting installation
          const blockStatus = await uiService.isProjectBlocked(
            projectId,
            "unknown"
          );
          if (blockStatus.blocked) {
            // Log blocked attempt
            await uiService.logInstallationAttempt(
              projectId,
              "unknown",
              "blocked",
              serverId,
              undefined,
              versionId,
              `Project blocked: ${blockStatus.reason}`
            );

            return res.status(403).json({
              success: false,
              error: "Project installation is blocked by administrator",
              reason: blockStatus.reason,
            });
          }

          // Start installation in background with statistics logging
          this.installModpack(serverId, projectId, versionId, uiService).catch(
            (error) => {
              this.logger?.error("Background installation failed:", error);
            }
          );

          res.json({ success: true, message: "Installation started" });
        } catch (error: any) {
          this.logger?.error("Install API error:", error);
          res.status(500).json({
            success: false,
            error: error.message || "Installation failed to start",
          });
        }
      }
    );

    // Upload API (with proper authentication and file validation)
    router.post(
      "/api/upload/:serverId",
      isAuthenticatedForServer("serverId"),
      this.upload.single("modpack"),
      async (req: Request, res: Response) => {
        try {
          const { serverId } = req.params;
          this.validateServerId(serverId);

          if (!req.file) {
            return res
              .status(400)
              .json({ success: false, error: "No file uploaded" });
          }

          if (this.isInstallationInProgress(serverId)) {
            return res.status(409).json({
              success: false,
              error: "Installation already in progress for this server",
            });
          }

          const server = await this.prisma.server.findUnique({
            where: { UUID: serverId },
            include: { node: true },
          });

          if (!server) {
            return res
              .status(404)
              .json({ success: false, error: "Server not found" });
          }

          const filename = req.file.originalname.toLowerCase();
          this.logger?.info(
            `Processing uploaded file: ${filename} (${req.file.size} bytes)`
          );

          // Process file based on type with statistics logging
          if (filename.endsWith(".mrpack")) {
            await this.installMrpack(server, req.file.buffer, uiService);
          } else if (filename.endsWith(".zip")) {
            await this.installZipFile(server, req.file.buffer, uiService);
          } else if (filename.endsWith(".jar")) {
            // Log JAR upload
            await uiService.logInstallationAttempt(
              "jar-upload",
              "mod",
              "in_progress",
              server.UUID,
              req.file.originalname
            );

            const success = await this.backendLogic.uploadFileToServer(
              server,
              "mods",
              req.file.originalname,
              req.file.buffer
            );

            if (!success) {
              await uiService.updateInstallationStatus(
                "jar-upload",
                "upload",
                server.UUID,
                "failed",
                "Failed to upload JAR file"
              );
              throw new Error("Failed to upload JAR file");
            }

            await uiService.updateInstallationStatus(
              "jar-upload",
              "upload",
              server.UUID,
              "completed"
            );
          } else {
            return res.status(400).json({
              success: false,
              error: `Unsupported file type. Allowed: ${this.config.ALLOWED_FILE_TYPES.join(
                ", "
              )}`,
            });
          }

          res.json({
            success: true,
            message: `File ${filename} processed successfully`,
          });
        } catch (error: any) {
          this.logger?.error("Upload API error:", error);
          res
            .status(500)
            .json({ success: false, error: error.message || "Upload failed" });
        }
      }
    );
    // Handle multer errors
    router.use(
      (error: any, req: Request, res: Response, next: NextFunction) => {
        if (error instanceof multer.MulterError) {
          if (error.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({
              success: false,
              error: `File too large. Maximum size: ${Math.round(
                this.config.MAX_FILE_SIZE / 1024 / 1024
              )}MB`,
            });
          }
          if (error.code === "LIMIT_FILE_COUNT") {
            return res
              .status(400)
              .json({ success: false, error: "Only one file allowed" });
          }
        }

        if (error.message && error.message.includes("Invalid file type")) {
          return res.status(400).json({ success: false, error: error.message });
        }

        next(error);
      }
    );

    // Installations API
    router.get(
      "/api/installations/:serverId",
      isAuthenticatedForServer("serverId"),
      async (req: Request, res: Response) => {
        try {
          const { serverId } = req.params;
          this.validateServerId(serverId);

          const installations = await this.prisma.$queryRaw`
          SELECT * FROM ModrinthInstallations 
          WHERE serverId = ${serverId} 
          ORDER BY id DESC
          LIMIT 50
        `;

          res.json({ success: true, data: installations || [] });
        } catch (error: any) {
          this.logger?.error("Installations API error:", error);
          res
            .status(500)
            .json({ success: false, error: "Failed to get installations" });
        }
      }
    );

    // Servers API
    router.get("/api/servers", async (req: Request, res: Response) => {
      const userId = req.session?.user?.id;
      if (!userId) {
        return res
          .status(401)
          .json({ success: false, error: "Not authenticated" });
      }

      try {
        const user = await this.prisma.users.findUnique({
          where: { id: userId },
        });
        if (!user) {
          return res
            .status(404)
            .json({ success: false, error: "User not found" });
        }

        const servers = user.isAdmin
          ? await this.prisma.server.findMany({
              select: {
                UUID: true,
                name: true,
                description: true,
                Installing: true,
                Suspended: true,
              },
              orderBy: { name: "asc" },
              take: 100, // Limit results
            })
          : await this.prisma.server.findMany({
              where: { ownerId: userId },
              select: {
                UUID: true,
                name: true,
                description: true,
                Installing: true,
                Suspended: true,
              },
              orderBy: { name: "asc" },
              take: 100,
            });

        res.json({
          success: true,
          data: servers.map((server: any) => ({
            id: server.UUID,
            name: server.name,
            description: server.description || "",
            status: server.Installing
              ? "installing"
              : server.Suspended
              ? "suspended"
              : "running",
          })),
        });
      } catch (error: any) {
        this.logger?.error("Servers API error:", error);
        res
          .status(500)
          .json({ success: false, error: "Failed to get servers" });
      }
    });

    // Server install API
    router.post(
      "/server/:serverId/install",
      isAuthenticatedForServer("serverId"),
      async (req: Request, res: Response) => {
        try {
          const { serverId } = req.params;
          const { projectId, versionId } = req.body;

          this.validateServerId(serverId);
          this.validateProjectData(projectId, versionId);

          if (this.isInstallationInProgress(serverId, versionId)) {
            return res.status(409).json({
              success: false,
              error: "Installation already in progress",
            });
          }

          // Don't await - start installation in background
          this.installModpack(serverId, projectId, versionId).catch((error) => {
            this.logger?.error("Background installation failed:", error);
          });

          res.json({ success: true, message: "Installation started" });
        } catch (error: any) {
          this.logger?.error("Server install API error:", error);
          res.status(500).json({
            success: false,
            error: error.message || "Installation failed to start",
          });
        }
      }
    );

    // Installation status
    router.get(
      "/api/installation/:serverId/:versionId/status",
      isAuthenticatedForServer("serverId"),
      async (req: Request, res: Response) => {
        try {
          const { serverId, versionId } = req.params;
          this.validateServerId(serverId);

          if (!versionId || typeof versionId !== "string") {
            return res
              .status(400)
              .json({ success: false, error: "Version ID required" });
          }

          const installation = await this.prisma.$queryRaw`
          SELECT * FROM ModrinthInstallations 
          WHERE serverId = ${serverId} AND versionId = ${versionId}
          ORDER BY id DESC LIMIT 1
        `;

          if (
            !installation ||
            (Array.isArray(installation) && installation.length === 0)
          ) {
            return res
              .status(404)
              .json({ success: false, error: "Installation not found" });
          }

          const installData = Array.isArray(installation)
            ? installation[0]
            : installation;
          res.json({
            success: true,
            data: {
              status: installData.status,
              error: installData.error || null,
              installedAt: installData.installedAt || null,
              projectName: installData.projectName || "",
              fileName: installData.fileName || "",
              inProgress: this.isInstallationInProgress(serverId, versionId),
            },
          });
        } catch (error: any) {
          this.logger?.error("Installation status API error:", error);
          res.status(500).json({
            success: false,
            error: "Failed to get installation status",
          });
        }
      }
    );

    // Health check
    router.get("/api/health", async (req: Request, res: Response) => {
      try {
        const testSearch = await this.searchModrinth("minecraft", "mod", 1);
        res.json({
          success: true,
          status: "healthy",
          timestamp: new Date().toISOString(),
          modrinth_api: testSearch.total_hits > 0 ? "accessible" : "limited",
          cache_enabled: !!this.prisma,
          active_installations: this.activeInstallations.size,
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          status: "unhealthy",
          error: error.message,
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Clear cache (admin only)
    router.post("/api/cache/clear", async (req: Request, res: Response) => {
      try {
        if (!req.session?.user?.id) {
          return res
            .status(401)
            .json({ success: false, error: "Not authenticated" });
        }

        const user = await this.prisma.users.findUnique({
          where: { id: req.session.user.id },
        });
        if (!user?.isAdmin) {
          return res
            .status(403)
            .json({ success: false, error: "Admin access required" });
        }

        await this.prisma.$executeRaw`DELETE FROM ModrinthCache`;
        this.logger?.info("Cache cleared by admin user");
        res.json({ success: true, message: "Cache cleared" });
      } catch (error: any) {
        this.logger?.error("Cache clear error:", error);
        res
          .status(500)
          .json({ success: false, error: "Failed to clear cache" });
      }
    });

    // Installation management (admin only)
    router.get("/api/installations", async (req: Request, res: Response) => {
      try {
        if (!req.session?.user?.id) {
          return res
            .status(401)
            .json({ success: false, error: "Not authenticated" });
        }

        const user = await this.prisma.users.findUnique({
          where: { id: req.session.user.id },
        });
        if (!user?.isAdmin) {
          return res
            .status(403)
            .json({ success: false, error: "Admin access required" });
        }

        const installations = await this.prisma.$queryRaw`
          SELECT * FROM ModrinthInstallations 
          ORDER BY id DESC
          LIMIT 100
        `;

        res.json({
          success: true,
          data: {
            installations: installations || [],
            active_count: this.activeInstallations.size,
          },
        });
      } catch (error: any) {
        this.logger?.error("All installations API error:", error);
        res
          .status(500)
          .json({ success: false, error: "Failed to get installations" });
      }
    });
    router.get(
      "/api/progress/:serverId/:projectId",
      async (req: Request, res: Response) => {
        try {
          const { serverId, projectId } = req.params;

          const progress = progressTracker.getProgress(serverId, projectId);

          if (!progress) {
            return res.json({
              success: true,
              active: false,
              message: "No active installation",
            });
          }

          res.json({
            success: true,
            active: true,
            data: progressTracker.serializeProgress(progress),
          });
        } catch (error: any) {
          res.status(500).json({
            success: false,
            error: error.message,
          });
        }
      }
    );

    // Get all active installations
    router.get("/api/progress", async (req: Request, res: Response) => {
      try {
        const allProgress = progressTracker.getAllProgress();

        res.json({
          success: true,
          active: allProgress.length > 0,
          installations: allProgress.map((p) =>
            progressTracker.serializeProgress(p)
          ),
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message,
        });
      }
    });

    // Clear progress (optional - for manual cleanup)
    router.delete(
      "/api/progress/:serverId/:projectId",
      async (req: Request, res: Response) => {
        try {
          const { serverId, projectId } = req.params;

          progressTracker.clearProgress(serverId, projectId);

          res.json({
            success: true,
            message: "Progress cleared",
          });
        } catch (error: any) {
          res.status(500).json({
            success: false,
            error: error.message,
          });
        }
      }
    );
  }

  // debug
  async debugStatistics(): Promise<void> {
    try {
      const tables = await this.prisma.$queryRawUnsafe(`
      SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%Modrinth%'
    `);
      this.logger.info("Existing tables:", tables);

      if (tables.some((t: any) => t.name === "ModrinthInstallations")) {
        const count = await this.prisma.$queryRawUnsafe(`
        SELECT COUNT(*) as count FROM ModrinthInstallations
      `);
        this.logger.info("Total records:", count);
      }
    } catch (error) {
      this.logger.error("Debug error:", error);
    }
  }
}
