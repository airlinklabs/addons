import { Router, Request, Response, NextFunction } from "express";
import path from "path";
import axios from "axios";
import { BackendLogic } from "./handlers/backend-logic";
import { ModpackInstaller } from "./handlers/installer";
import { AddonAPI, ModrinthProject, ModrinthVersion } from "./types/types";
import { UIService } from "./ui";
import { progressTracker } from "./handlers/progress-tracker";

const multer = require("multer");

function isAuthenticatedForServer(serverIdParam = "id") {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const prisma = (req as any).__prisma;
    if (!prisma) {
      res.status(500).json({ error: "Database connection not available" });
      return;
    }

    const userId = req.session?.user?.id;
    if (!userId) {
      req.path.startsWith("/api/")
        ? res.status(401).json({ success: false, error: "Authentication required" })
        : res.redirect("/login");
      return;
    }

    try {
      const user = await prisma.users.findUnique({ where: { id: userId } });
      if (!user) {
        req.path.startsWith("/api/")
          ? res.status(401).json({ success: false, error: "User not found" })
          : res.redirect("/login");
        return;
      }

      if (user.isAdmin) { next(); return; }

      const serverId = req.params[serverIdParam];
      if (!serverId) {
        res.status(400).json({ success: false, error: "Server ID required" });
        return;
      }

      const server = await prisma.server.findUnique({ where: { UUID: serverId } });
      if (!server) {
        res.status(404).json({ success: false, error: "Server not found" });
        return;
      }

      if (server.ownerId === userId) { next(); return; }

      req.path.startsWith("/api/")
        ? res.status(403).json({ success: false, error: "Access denied" })
        : res.redirect("/");
    } catch (error) {
      req.path.startsWith("/api/")
        ? res.status(500).json({ success: false, error: "Authentication error" })
        : res.redirect("/");
    }
  };
}

export class ModrinthService {
  private config: any;
  private upload: any;
  private backendLogic: BackendLogic;
  private installer: ModpackInstaller;
  private activeInstallations = new Map<string, boolean>();

  constructor(private prisma: any, private logger: any, config: any) {
    this.config = {
      CACHE_DURATION: 10 * 60 * 1000,
      SEARCH_LIMIT: 20,
      MAX_FILE_SIZE: 500 * 1024 * 1024,
      MODRINTH_API_BASE: "https://api.modrinth.com/v2",
      USER_AGENT: "Modrinth-Addon/1.0.0",
      MAX_CONCURRENT_DOWNLOADS: 3,
      DOWNLOAD_TIMEOUT: 300000,
      RETRY_ATTEMPTS: 3,
      RETRY_DELAY: 2000,
      ALLOWED_FILE_TYPES: [".mrpack", ".zip", ".jar"],
      ...config,
    };

    this.backendLogic = new BackendLogic(logger, this.config);
    this.installer = new ModpackInstaller(prisma, logger, this.config);

    this.upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: this.config.MAX_FILE_SIZE, files: 1 },
      fileFilter: (_req: any, file: any, cb: any) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (this.config.ALLOWED_FILE_TYPES.includes(ext)) {
          cb(null, true);
        } else {
          cb(new Error(`Invalid file type. Allowed: ${this.config.ALLOWED_FILE_TYPES.join(", ")}`));
        }
      },
    });
  }

  async getCachedData(cacheKey: string): Promise<any> {
    try {
      if (!this.prisma || !cacheKey) return null;
      const rows = await this.prisma.$queryRaw`
        SELECT data FROM ModrinthCache
        WHERE cacheKey = ${cacheKey} AND expiresAt > datetime('now')
        LIMIT 1
      `;
      if (Array.isArray(rows) && rows.length > 0 && rows[0]?.data) {
        return JSON.parse(rows[0].data);
      }
      return null;
    } catch {
      return null;
    }
  }

  async setCachedData(cacheKey: string, data: any, duration = this.config.CACHE_DURATION): Promise<void> {
    try {
      if (!this.prisma || !cacheKey || !data) return;
      const serialized = JSON.stringify(data);
      if (serialized.length > 10 * 1024 * 1024) return;
      const expiresAt = new Date(Date.now() + duration).toISOString();
      await this.prisma.$executeRaw`
        INSERT OR REPLACE INTO ModrinthCache (cacheKey, data, expiresAt)
        VALUES (${cacheKey}, ${serialized}, ${expiresAt})
      `;
    } catch {
      // non-critical
    }
  }

  private async clearExpiredCache(): Promise<void> {
    try {
      await this.prisma.$executeRaw`DELETE FROM ModrinthCache WHERE expiresAt <= datetime('now')`;
    } catch {
      // non-critical
    }
  }

  async makeModrinthRequest(endpoint: string, params?: any): Promise<any> {
    if (!endpoint) throw new Error("Invalid endpoint");

    if (Math.random() < 0.01) this.clearExpiredCache().catch(() => {});

    const cacheKey = `modrinth:${endpoint}:${JSON.stringify(params || {})}`;
    const cached = await this.getCachedData(cacheKey);
    if (cached) return cached;

    let attempt = 0;
    let lastError: any;

    while (attempt < this.config.RETRY_ATTEMPTS) {
      try {
        const response = await axios.get(`${this.config.MODRINTH_API_BASE}${endpoint}`, {
          params,
          headers: { "User-Agent": this.config.USER_AGENT, Accept: "application/json" },
          timeout: 30000,
          validateStatus: (s) => s < 500,
        });

        if (response.status >= 400) {
          throw new Error(`API returned ${response.status}`);
        }

        await this.setCachedData(cacheKey, response.data);
        return response.data;
      } catch (error: any) {
        lastError = error;
        attempt++;

        if (error.response?.status >= 400 && error.response?.status < 500) throw error;
        if (attempt >= this.config.RETRY_ATTEMPTS) throw error;

        const delay = this.config.RETRY_DELAY * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw lastError;
  }

  async searchModrinth(query: string, type = "all", page = 1) {
    try {
      const params: any = {
        query: query?.trim() || "",
        offset: Math.max(0, (page - 1) * this.config.SEARCH_LIMIT),
        limit: Math.min(this.config.SEARCH_LIMIT, 100),
        index: "relevance",
      };

      if (type && type !== "all" && ["mod", "modpack", "resourcepack", "shader"].includes(type)) {
        params.facets = JSON.stringify([[`project_type:${type}`]]);
      }

      const result = await this.makeModrinthRequest("/search", params);
      return {
        hits: result.hits || [],
        total_hits: result.total_hits || 0,
        offset: result.offset || 0,
        limit: result.limit || this.config.SEARCH_LIMIT,
      };
    } catch {
      return { hits: [], total_hits: 0, offset: 0, limit: this.config.SEARCH_LIMIT };
    }
  }

  async getProject(projectId: string): Promise<ModrinthProject> {
    if (!projectId?.trim()) throw new Error("Project ID is required");
    return this.makeModrinthRequest(`/project/${encodeURIComponent(projectId.trim())}`);
  }

  async getProjectVersions(projectId: string): Promise<ModrinthVersion[]> {
    if (!projectId?.trim()) throw new Error("Project ID is required");
    return this.makeModrinthRequest(`/project/${encodeURIComponent(projectId.trim())}/version`);
  }

  private installKey(serverId: string, versionId?: string) {
    return versionId ? `${serverId}:${versionId}` : serverId;
  }

  private isInstalling(serverId: string, versionId?: string) {
    return this.activeInstallations.has(this.installKey(serverId, versionId));
  }

  private setInstalling(serverId: string, versionId?: string) {
    this.activeInstallations.set(this.installKey(serverId, versionId), true);
  }

  private clearInstalling(serverId: string, versionId?: string) {
    this.activeInstallations.delete(this.installKey(serverId, versionId));
  }

  async installModpack(serverId: string, projectId: string, versionId: string, uiService?: UIService): Promise<void> {
    if (this.isInstalling(serverId, versionId)) {
      throw new Error("Installation already in progress");
    }

    this.setInstalling(serverId, versionId);

    try {
      const project = await this.getProject(projectId);
      const projectName = project.title || projectId;
      const projectType = project.project_type || "unknown";

      if (uiService) {
        await uiService.logInstallationAttempt(projectId, projectType, "in_progress", serverId, projectName, versionId);
      }

      await this.installer.installModpack(
        serverId, projectId, versionId,
        this.getCachedData.bind(this),
        this.setCachedData.bind(this),
        this.makeModrinthRequest.bind(this)
      );

      if (uiService) {
        await uiService.updateInstallationStatus(projectId, versionId, serverId, "completed");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      if (uiService) {
        await uiService.updateInstallationStatus(projectId, versionId, serverId, "failed", msg);
      }
      throw error;
    } finally {
      this.clearInstalling(serverId, versionId);
    }
  }

  async installMrpack(server: any, mrpackBuffer: Buffer, uiService?: UIService): Promise<void> {
    if (this.isInstalling(server.UUID)) throw new Error("Installation already in progress");

    this.setInstalling(server.UUID);
    try {
      if (uiService) await uiService.logInstallationAttempt("mrpack-upload", "modpack", "in_progress", server.UUID, "Uploaded Modpack");

      await this.installer.installMrpack(
        server, mrpackBuffer,
        this.getCachedData.bind(this),
        this.setCachedData.bind(this)
      );

      if (uiService) await uiService.updateInstallationStatus("mrpack-upload", "upload", server.UUID, "completed");
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      if (uiService) await uiService.updateInstallationStatus("mrpack-upload", "upload", server.UUID, "failed", msg);
      throw error;
    } finally {
      this.clearInstalling(server.UUID);
    }
  }

  async installZipFile(server: any, zipBuffer: Buffer, uiService?: UIService): Promise<void> {
    if (this.isInstalling(server.UUID)) throw new Error("Installation already in progress");

    this.setInstalling(server.UUID);
    try {
      if (uiService) await uiService.logInstallationAttempt("zip-upload", "modpack", "in_progress", server.UUID, "Uploaded ZIP");

      await this.installer.installZipFile(server, zipBuffer);

      if (uiService) await uiService.updateInstallationStatus("zip-upload", "upload", server.UUID, "completed");
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      if (uiService) await uiService.updateInstallationStatus("zip-upload", "upload", server.UUID, "failed", msg);
      throw error;
    } finally {
      this.clearInstalling(server.UUID);
    }
  }

  private validateServerId(serverId: string): void {
    if (!serverId?.trim()) throw new Error("Valid server ID is required");
  }

  private validateProjectData(projectId: string, versionId: string): void {
    if (!projectId?.trim()) throw new Error("Valid project ID is required");
    if (!versionId?.trim()) throw new Error("Valid version ID is required");
  }

  setupRoutes(router: Router, _api: AddonAPI, uiService: UIService): void {
    router.get("/api/search", async (req: Request, res: Response) => {
      try {
        const query = String(req.query.q || "").trim();
        const type = String(req.query.type || "all").trim();
        const page = Math.max(1, parseInt(req.query.page as string) || 1);

        if (query.length > 100) {
          return res.status(400).json({ success: false, error: "Query too long" });
        }

        const results = await this.searchModrinth(query, type, page);
        res.json({ success: true, data: results });
      } catch (error: any) {
        res.status(500).json({ success: false, error: "Search failed" });
      }
    });

    router.get("/api/project/:id", async (req: Request, res: Response) => {
      try {
        const id = req.params.id?.trim();
        if (!id || id.length > 100) {
          return res.status(400).json({ success: false, error: "Invalid project ID" });
        }

        const [project, versions] = await Promise.all([
          this.getProject(id),
          this.getProjectVersions(id),
        ]);

        res.json({ success: true, data: { project, versions } });
      } catch (error: any) {
        if (error.response?.status === 404) {
          res.status(404).json({ success: false, error: "Project not found" });
        } else {
          res.status(500).json({ success: false, error: "Failed to get project" });
        }
      }
    });

    router.post("/api/install", isAuthenticatedForServer("serverId"), async (req: Request, res: Response) => {
      try {
        const { serverId, projectId, versionId } = req.body;

        this.validateServerId(serverId);
        this.validateProjectData(projectId, versionId);

        if (this.isInstalling(serverId, versionId)) {
          return res.status(409).json({ success: false, error: "Installation already in progress" });
        }

        const blockStatus = await uiService.isProjectBlocked(projectId, "unknown");
        if (blockStatus.blocked) {
          await uiService.logInstallationAttempt(
            projectId, "unknown", "blocked", serverId, undefined, versionId,
            `Project blocked: ${blockStatus.reason}`
          );
          return res.status(403).json({
            success: false,
            error: "Project installation is blocked by administrator",
            reason: blockStatus.reason,
          });
        }

        this.installModpack(serverId, projectId, versionId, uiService).catch(() => {});
        res.json({ success: true, message: "Installation started" });
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to start" });
      }
    });

    router.post(
      "/api/upload/:serverId",
      isAuthenticatedForServer("serverId"),
      this.upload.single("modpack"),
      async (req: Request, res: Response) => {
        try {
          const { serverId } = req.params;
          this.validateServerId(serverId);

          if (!req.file) {
            return res.status(400).json({ success: false, error: "No file uploaded" });
          }

          if (this.isInstalling(serverId)) {
            return res.status(409).json({ success: false, error: "Installation already in progress" });
          }

          const server = await this.prisma.server.findUnique({
            where: { UUID: serverId },
            include: { node: true },
          });

          if (!server) {
            return res.status(404).json({ success: false, error: "Server not found" });
          }

          const filename = req.file.originalname.toLowerCase();

          if (filename.endsWith(".mrpack")) {
            await this.installMrpack(server, req.file.buffer, uiService);
          } else if (filename.endsWith(".zip")) {
            await this.installZipFile(server, req.file.buffer, uiService);
          } else if (filename.endsWith(".jar")) {
            await uiService.logInstallationAttempt("jar-upload", "mod", "in_progress", server.UUID, req.file.originalname);

            const ok = await this.backendLogic.uploadFileToServer(server, "mods", req.file.originalname, req.file.buffer);
            if (!ok) {
              await uiService.updateInstallationStatus("jar-upload", "upload", server.UUID, "failed", "Upload failed");
              throw new Error("Failed to upload JAR file");
            }

            await uiService.updateInstallationStatus("jar-upload", "upload", server.UUID, "completed");
          } else {
            return res.status(400).json({ success: false, error: `Unsupported file type` });
          }

          res.json({ success: true, message: `${filename} processed successfully` });
        } catch (error: any) {
          res.status(500).json({ success: false, error: error.message || "Upload failed" });
        }
      }
    );

    router.use((error: any, req: Request, res: Response, next: NextFunction) => {
      if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({
            success: false,
            error: `File too large. Max: ${Math.round(this.config.MAX_FILE_SIZE / 1024 / 1024)}MB`,
          });
        }
        if (error.code === "LIMIT_FILE_COUNT") {
          return res.status(400).json({ success: false, error: "Only one file allowed" });
        }
      }
      if (error.message?.includes("Invalid file type")) {
        return res.status(400).json({ success: false, error: error.message });
      }
      next(error);
    });

    router.get("/api/installations/:serverId", isAuthenticatedForServer("serverId"), async (req: Request, res: Response) => {
      try {
        const { serverId } = req.params;
        this.validateServerId(serverId);

        const rows = await this.prisma.$queryRaw`
          SELECT * FROM ModrinthInstallation
          WHERE serverId = ${serverId}
          ORDER BY id DESC LIMIT 50
        `;

        res.json({ success: true, data: rows || [] });
      } catch {
        res.status(500).json({ success: false, error: "Failed to get installations" });
      }
    });

    router.get("/api/servers", async (req: Request, res: Response) => {
      const userId = req.session?.user?.id;
      if (!userId) return res.status(401).json({ success: false, error: "Not authenticated" });

      try {
        const user = await this.prisma.users.findUnique({ where: { id: userId } });
        if (!user) return res.status(404).json({ success: false, error: "User not found" });

        const where = user.isAdmin ? {} : { ownerId: userId };
        const servers = await this.prisma.server.findMany({
          where,
          select: { UUID: true, name: true, description: true, Installing: true, Suspended: true },
          orderBy: { name: "asc" },
          take: 100,
        });

        res.json({
          success: true,
          data: servers.map((s: any) => ({
            id: s.UUID,
            name: s.name,
            description: s.description || "",
            status: s.Installing ? "installing" : s.Suspended ? "suspended" : "running",
          })),
        });
      } catch {
        res.status(500).json({ success: false, error: "Failed to get servers" });
      }
    });

    router.get("/api/installation/:serverId/:versionId/status", isAuthenticatedForServer("serverId"), async (req: Request, res: Response) => {
      try {
        const { serverId, versionId } = req.params;
        this.validateServerId(serverId);
        if (!versionId) return res.status(400).json({ success: false, error: "Version ID required" });

        const rows = await this.prisma.$queryRaw`
          SELECT * FROM ModrinthInstallation
          WHERE serverId = ${serverId} AND versionId = ${versionId}
          ORDER BY id DESC LIMIT 1
        `;

        if (!rows || (Array.isArray(rows) && rows.length === 0)) {
          return res.status(404).json({ success: false, error: "Installation not found" });
        }

        const row = Array.isArray(rows) ? rows[0] : rows;
        res.json({
          success: true,
          data: {
            status: row.status,
            error: row.error || null,
            installedAt: row.installedAt || null,
            projectName: row.projectName || "",
            inProgress: this.isInstalling(serverId, versionId),
          },
        });
      } catch {
        res.status(500).json({ success: false, error: "Failed to get installation status" });
      }
    });

    router.get("/api/health", async (_req: Request, res: Response) => {
      try {
        const test = await this.searchModrinth("minecraft", "mod", 1);
        res.json({
          success: true,
          status: "healthy",
          timestamp: new Date().toISOString(),
          modrinth_api: test.total_hits > 0 ? "accessible" : "limited",
          active_installations: this.activeInstallations.size,
        });
      } catch (error: any) {
        res.status(500).json({ success: false, status: "unhealthy", error: error.message });
      }
    });

    router.post("/api/cache/clear", async (req: Request, res: Response) => {
      const userId = req.session?.user?.id;
      if (!userId) return res.status(401).json({ success: false, error: "Not authenticated" });

      try {
        const user = await this.prisma.users.findUnique({ where: { id: userId } });
        if (!user?.isAdmin) return res.status(403).json({ success: false, error: "Admin required" });

        await this.prisma.$executeRaw`DELETE FROM ModrinthCache`;
        res.json({ success: true, message: "Cache cleared" });
      } catch {
        res.status(500).json({ success: false, error: "Failed to clear cache" });
      }
    });

    router.get("/api/installations", async (req: Request, res: Response) => {
      const userId = req.session?.user?.id;
      if (!userId) return res.status(401).json({ success: false, error: "Not authenticated" });

      try {
        const user = await this.prisma.users.findUnique({ where: { id: userId } });
        if (!user?.isAdmin) return res.status(403).json({ success: false, error: "Admin required" });

        const rows = await this.prisma.$queryRaw`
          SELECT * FROM ModrinthInstallation ORDER BY id DESC LIMIT 100
        `;

        res.json({ success: true, data: { installations: rows || [], active_count: this.activeInstallations.size } });
      } catch {
        res.status(500).json({ success: false, error: "Failed to get installations" });
      }
    });

    router.get("/api/progress/:serverId/:projectId", async (req: Request, res: Response) => {
      try {
        const { serverId, projectId } = req.params;
        const progress = progressTracker.getProgress(serverId, projectId);

        if (!progress) {
          return res.json({ success: true, active: false, message: "No active installation" });
        }

        res.json({ success: true, active: true, data: progressTracker.serializeProgress(progress) });
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    router.get("/api/progress", async (_req: Request, res: Response) => {
      try {
        const all = progressTracker.getAllProgress();
        res.json({
          success: true,
          active: all.length > 0,
          installations: all.map((p) => progressTracker.serializeProgress(p)),
        });
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    router.delete("/api/progress/:serverId/:projectId", async (req: Request, res: Response) => {
      try {
        progressTracker.clearProgress(req.params.serverId, req.params.projectId);
        res.json({ success: true, message: "Progress cleared" });
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
  }
}
