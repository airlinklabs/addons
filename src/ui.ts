import { Router, Request, Response } from "express";
import path from "path";
import * as fs from "fs/promises";

interface AddonAPI {
  registerRoute: (path: string, router: Router) => void;
  logger: any;
  prisma: any;
  addonPath: string;
  viewsPath: string;
  desktopViewsPath: string;
  mobileViewsPath: string;
  getComponentPath: (componentPath: string) => string;
  ui?: {
    addSidebarItem?: (item: any) => void;
    addServerMenuItem?: (item: any) => void;
  };
}

interface ModrinthSettings {
  modrinthInstallationWarning: boolean;
  warningTitle: string;
  warningMessage: string;
  disabledProjectTypes: string[];
  blockedProjects: string[];
}

const DEFAULT_SETTINGS: ModrinthSettings = {
  modrinthInstallationWarning: false,
  warningTitle: "Installation Temporarily Disabled",
  warningMessage: "Installations are temporarily disabled due to technical issues in the backend.",
  disabledProjectTypes: [],
  blockedProjects: [],
};

export class UIService {
  private prisma: any;
  private settingsCache: ModrinthSettings | null = null;
  private cacheExpiry = 0;

  constructor(private api: AddonAPI) {
    this.prisma = api.prisma;
  }

  private isMobileRequest(req: Request): boolean {
    return (req as any).cookies?.viewport_mode === "mobile";
  }

  private resolveView(viewName: string, isMobile: boolean): string {
    const mobileView = path.join(this.api.mobileViewsPath, viewName);
    const desktopView = path.join(this.api.desktopViewsPath, viewName);
    const fallbackView = path.join(this.api.viewsPath, viewName);

    const syncExists = (p: string) => {
      try {
        require("fs").accessSync(p);
        return true;
      } catch {
        return false;
      }
    };

    if (isMobile && syncExists(mobileView)) return mobileView;
    if (syncExists(desktopView)) return desktopView;
    return fallbackView;
  }

  private components(req: Request) {
    const isMobile = this.isMobileRequest(req);
    const viewport = isMobile ? "mobile" : "desktop";
    return {
      header: this.api.getComponentPath(`views/${viewport}/components/header`),
      template: this.api.getComponentPath(`views/${viewport}/components/template`),
      footer: this.api.getComponentPath(`views/${viewport}/components/footer`),
    };
  }

  private async getGlobalSettings(): Promise<any> {
    try {
      return await this.prisma.settings.findFirst().catch(() => null) || {
        title: "Control Panel",
        logo: "/assets/logo.png",
        theme: "dark",
      };
    } catch {
      return { title: "Control Panel", logo: "/assets/logo.png", theme: "dark" };
    }
  }

  private async getModrinthSettings(): Promise<ModrinthSettings> {
    const now = Date.now();
    if (this.settingsCache && now < this.cacheExpiry) return this.settingsCache;

    const settingsPath = path.join(this.api.addonPath, "modrinth-settings.json");

    try {
      const raw = await fs.readFile(settingsPath, "utf8");
      const parsed = JSON.parse(raw);

      const settings: ModrinthSettings = {
        modrinthInstallationWarning: Boolean(parsed.modrinthInstallationWarning),
        warningTitle: typeof parsed.warningTitle === "string" && parsed.warningTitle.trim()
          ? parsed.warningTitle
          : DEFAULT_SETTINGS.warningTitle,
        warningMessage: typeof parsed.warningMessage === "string" && parsed.warningMessage.trim()
          ? parsed.warningMessage
          : DEFAULT_SETTINGS.warningMessage,
        disabledProjectTypes: Array.isArray(parsed.disabledProjectTypes)
          ? parsed.disabledProjectTypes.filter((t: any) => typeof t === "string" && t.trim())
          : [],
        blockedProjects: Array.isArray(parsed.blockedProjects)
          ? parsed.blockedProjects.filter((p: any) => typeof p === "string" && p.trim())
          : [],
      };

      this.settingsCache = settings;
      this.cacheExpiry = now + 30000;
      return settings;
    } catch {
      const defaultSettings = { ...DEFAULT_SETTINGS };
      try {
        await this.saveModrinthSettings(defaultSettings);
        this.settingsCache = defaultSettings;
        this.cacheExpiry = now + 30000;
      } catch {}
      return defaultSettings;
    }
  }

  private clearSettingsCache(): void {
    this.settingsCache = null;
    this.cacheExpiry = 0;
  }

  private async saveModrinthSettings(settings: ModrinthSettings): Promise<void> {
    const settingsPath = path.join(this.api.addonPath, "modrinth-settings.json");

    const clean: ModrinthSettings = {
      modrinthInstallationWarning: Boolean(settings.modrinthInstallationWarning),
      warningTitle: settings.warningTitle?.trim() || DEFAULT_SETTINGS.warningTitle,
      warningMessage: settings.warningMessage?.trim() || DEFAULT_SETTINGS.warningMessage,
      disabledProjectTypes: Array.from(new Set<string>(
        (settings.disabledProjectTypes || [])
          .filter((t) => typeof t === "string" && t.trim())
          .map((t) => t.trim())
      )),
      blockedProjects: Array.from(new Set<string>(
        (settings.blockedProjects || [])
          .filter((p) => typeof p === "string" && p.trim())
          .map((p) => p.trim())
      )),
    };

    await fs.mkdir(this.api.addonPath, { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(clean, null, 2), "utf8");
    this.clearSettingsCache();
  }

  private async ensureStatisticsTable(): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe(`
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
    } catch {}
  }

  private async getInstallationStatistics(): Promise<any> {
    try {
      await this.ensureStatisticsTable();

      const [totalRows, projectRows, blockedRows] = await Promise.all([
        this.prisma.$queryRawUnsafe(`SELECT COUNT(*) as count FROM ModrinthInstallation WHERE status = 'completed'`),
        this.prisma.$queryRawUnsafe(`SELECT COUNT(DISTINCT projectId) as count FROM ModrinthInstallation WHERE status = 'completed'`),
        this.prisma.$queryRawUnsafe(`SELECT COUNT(*) as count FROM ModrinthInstallation WHERE status IN ('failed', 'blocked')`),
      ]);

      return {
        totalInstallations: Number(totalRows[0]?.count || 0),
        activeProjects: Number(projectRows[0]?.count || 0),
        blockedInstallations: Number(blockedRows[0]?.count || 0),
      };
    } catch {
      return { totalInstallations: 0, activeProjects: 0, blockedInstallations: 0 };
    }
  }

  async isProjectBlocked(projectId: string, projectType: string): Promise<{ blocked: boolean; reason: "type_disabled" | "project_blocked" | null }> {
    try {
      const settings = await this.getModrinthSettings();
      if (settings.disabledProjectTypes.includes(projectType)) return { blocked: true, reason: "type_disabled" };
      if (settings.blockedProjects.includes(projectId)) return { blocked: true, reason: "project_blocked" };
      return { blocked: false, reason: null };
    } catch {
      return { blocked: false, reason: null };
    }
  }

  async filterProjects(projects: any[]): Promise<any[]> {
    if (!Array.isArray(projects) || projects.length === 0) return projects;

    try {
      const settings = await this.getModrinthSettings();
      return projects.filter((p) => {
        if (settings.disabledProjectTypes.includes(p.project_type)) return false;
        const id = p.project_id || p.id;
        if (id && settings.blockedProjects.includes(id)) return false;
        return true;
      });
    } catch {
      return projects;
    }
  }

  setupUI(): void {
    if (!this.api.ui) {
      this.api.logger.warn("UI API not available - skipping UI setup");
      return;
    }

    this.api.ui.addSidebarItem?.({
      id: "modrinth-store",
      label: "Modrinth Store",
      icon: this.getStoreIcon(),
      url: "/modrinth",
      section: "main",
      order: 50,
      description: "Browse and install mods, modpacks, and plugins",
    });

    this.api.ui.addSidebarItem?.({
      id: "modrinth-admin-config",
      label: "Modrinth Admin",
      icon: this.getStoreIcon(),
      url: "/modrinth/admin/config",
      isAdminItem: true,
      order: 1,
      description: "Configure Modrinth addon settings",
    });
  }

  setupRoutes(router: Router, searchService: any): void {
    this.api.registerRoute("/modrinth", router);

    const express = require("express");
    router.use(express.json());
    router.use(express.urlencoded({ extended: true }));

    router.get("/", async (req: Request, res: Response) => {
      const userId = req.session?.user?.id;
      if (!userId) return res.redirect("/login");

      try {
        const query = String(req.query.q || "").trim();
        const type = String(req.query.type || "all");
        const page = Math.max(1, parseInt(req.query.page as string) || 1);

        const [user, globalSettings, modrinthSettings] = await Promise.all([
          this.prisma.users.findUnique({ where: { id: userId } }),
          this.getGlobalSettings(),
          this.getModrinthSettings(),
        ]);

        const rawResults = await searchService.searchModrinth(query || "", type || "modpack", page);
        const filteredHits = rawResults?.hits ? await this.filterProjects(rawResults.hits) : [];

        const isMobile = this.isMobileRequest(req);
        const viewPath = this.resolveView("browse.ejs", isMobile);

        res.render(viewPath, {
          title: "Modrinth Store",
          user,
          req,
          settings: globalSettings,
          modrinthSettings,
          query,
          type,
          page,
          results: { ...rawResults, hits: filteredHits, total_hits: filteredHits.length },
          totalPages: Math.ceil(filteredHits.length / 20),
          mods: filteredHits,
          featuredMods: filteredHits.slice(0, 5),
          components: this.components(req),
        });
      } catch (error) {
        this.api.logger.error("Error in browse page:", error);
        res.status(500).json({ error: "Failed to load page" });
      }
    });

    router.get("/:id/modrinth", this.isAuthenticatedForServer("id"), async (req: Request, res: Response) => {
      const userId = req.session?.user?.id;
      const serverId = req.params?.id;

      if (!serverId) return res.status(400).json({ error: "Server ID required" });

      try {
        const [user, server, installations, globalSettings, modrinthSettings] = await Promise.all([
          this.prisma.users.findUnique({ where: { id: userId } }),
          this.prisma.server.findUnique({ where: { UUID: serverId }, include: { node: true, image: true, owner: true } }),
          this.prisma.$queryRaw`SELECT * FROM ModrinthInstallation WHERE serverId = ${serverId} ORDER BY id DESC LIMIT 10`,
          this.getGlobalSettings(),
          this.getModrinthSettings(),
        ]);

        if (!user || !server) return res.status(404).json({ error: "Not found" });

        const isMobile = this.isMobileRequest(req);
        const viewPath = this.resolveView("browse.ejs", isMobile);
        const baseComponents = this.components(req);
        const viewport = isMobile ? "mobile" : "desktop";

        res.render(viewPath, {
          user, req, server,
          installations: installations || [],
          settings: globalSettings,
          modrinthSettings,
          features: JSON.parse(server.image?.info || "{}").features || [],
          installed: await this.checkForServerInstallation(serverId),
          components: {
            ...baseComponents,
            serverHeader: this.api.getComponentPath(`views/${viewport}/components/serverHeader`),
            installHeader: this.api.getComponentPath(`views/${viewport}/components/installHeader`),
            serverTemplate: this.api.getComponentPath(`views/${viewport}/components/serverTemplate`),
          },
        });
      } catch (error) {
        this.api.logger.error("Error in server modrinth page:", error);
        res.status(500).json({ error: "Failed to load page" });
      }
    });

    router.get("/project/:id", async (req: Request, res: Response) => {
      const userId = req.session?.user?.id;
      if (!userId) return res.redirect("/login");

      try {
        const { id } = req.params;
        if (!id) return res.status(400).json({ error: "Project ID required" });

        const [user, globalSettings, modrinthSettings, project, versions] = await Promise.all([
          this.prisma.users.findUnique({ where: { id: userId } }),
          this.getGlobalSettings(),
          this.getModrinthSettings(),
          searchService.getProject(id),
          searchService.getProjectVersions(id),
        ]);

        if (!user || !project) return res.status(404).json({ error: "Not found" });

        const blockStatus = await this.isProjectBlocked(project.id, project.project_type);
        const isMobile = this.isMobileRequest(req);
        const viewPath = this.resolveView("project.ejs", isMobile);

        res.render(viewPath, {
          title: `${project.title} - Modrinth`,
          user, req,
          settings: globalSettings,
          modrinthSettings,
          project,
          versions: versions || [],
          isProjectBlocked: blockStatus.blocked,
          blockReason: blockStatus.reason,
          components: this.components(req),
        });
      } catch (error) {
        this.api.logger.error("Error in project page:", error);
        res.status(500).json({ error: "Failed to load project" });
      }
    });

    router.get("/admin/config", this.isAdmin(), async (req: Request, res: Response) => {
      try {
        const [globalSettings, modrinthSettings] = await Promise.all([
          this.getGlobalSettings(),
          this.getModrinthSettings(),
        ]);

        const isMobile = this.isMobileRequest(req);
        const viewPath = this.resolveView("admin-config.ejs", isMobile);

        res.render(viewPath, {
          title: "Modrinth Configuration",
          user: req.session?.user,
          req,
          settings: globalSettings,
          modrinthSettings,
          components: this.components(req),
        });
      } catch (error) {
        this.api.logger.error("Error in admin config page:", error);
        res.status(500).json({ error: "Failed to load admin configuration" });
      }
    });

    router.post("/admin/config", this.isAdmin(), async (req: Request, res: Response) => {
      try {
        if (!req.body || typeof req.body !== "object") {
          return res.status(400).json({ success: false, error: "Invalid payload" });
        }

        const { modrinthInstallationWarning, warningTitle, warningMessage, disabledProjectTypes, blockedProjects } = req.body;

        const errors: string[] = [];
        if (typeof modrinthInstallationWarning !== "boolean") errors.push("modrinthInstallationWarning must be boolean");
        if (typeof warningTitle !== "string") errors.push("warningTitle must be string");
        if (typeof warningMessage !== "string") errors.push("warningMessage must be string");
        if (!Array.isArray(disabledProjectTypes)) errors.push("disabledProjectTypes must be array");
        if (!Array.isArray(blockedProjects)) errors.push("blockedProjects must be array");

        if (errors.length > 0) {
          return res.status(400).json({ success: false, error: errors.join(", ") });
        }

        const settingsToSave: ModrinthSettings = {
          modrinthInstallationWarning: Boolean(modrinthInstallationWarning),
          warningTitle: warningTitle?.trim() || DEFAULT_SETTINGS.warningTitle,
          warningMessage: warningMessage?.trim() || DEFAULT_SETTINGS.warningMessage,
          disabledProjectTypes: Array.from(new Set<string>(disabledProjectTypes.filter((t: any) => typeof t === "string" && t.trim()).map((t: any) => String(t).trim()))),
          blockedProjects: Array.from(new Set<string>(blockedProjects.filter((p: any) => typeof p === "string" && p.trim()).map((p: any) => String(p).trim()))),
        };

        await this.saveModrinthSettings(settingsToSave);
        res.json({ success: true, message: "Configuration saved", settings: settingsToSave });
      } catch (error) {
        this.api.logger.error("Error saving admin config:", error);
        res.status(500).json({ success: false, error: "Failed to save configuration" });
      }
    });

    router.get("/api/config", this.isAdmin(), async (_req: Request, res: Response) => {
      try {
        res.json({ success: true, data: await this.getModrinthSettings() });
      } catch {
        res.status(500).json({ error: "Failed to get configuration" });
      }
    });

    router.get("/api/statistics", this.isAdmin(), async (_req: Request, res: Response) => {
      try {
        res.json({ success: true, data: await this.getInstallationStatistics() });
      } catch {
        res.status(500).json({ error: "Failed to get statistics" });
      }
    });

    router.get("/api/settings", this.isAdmin(), async (_req: Request, res: Response) => {
      try {
        res.json(await this.getModrinthSettings());
      } catch {
        res.status(500).json({ error: "Failed to get settings" });
      }
    });

    router.get("/api/file-status", this.isAdmin(), async (_req: Request, res: Response) => {
      try {
        const settingsPath = path.join(this.api.addonPath, "modrinth-settings.json");
        try {
          const stats = await fs.stat(settingsPath);
          res.json({ success: true, data: { exists: true, size: stats.size, lastModified: stats.mtime, path: settingsPath } });
        } catch (e: any) {
          if (e.code === "ENOENT") {
            res.json({ success: true, data: { exists: false, size: 0, lastModified: null, path: settingsPath } });
          } else throw e;
        }
      } catch {
        res.status(500).json({ error: "Failed to get file status" });
      }
    });

    router.get("/api/project/:id/status", async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const { type } = req.query;
        if (!id || !type) return res.status(400).json({ error: "Project ID and type required" });

        const blockStatus = await this.isProjectBlocked(id, type as string);
        res.json({
          success: true,
          blocked: blockStatus.blocked,
          reason: blockStatus.reason,
          projectTypeDisabled: blockStatus.reason === "type_disabled",
          projectBlocked: blockStatus.reason === "project_blocked",
        });
      } catch {
        res.status(500).json({ error: "Failed to check project status" });
      }
    });

    router.get("/api/servers", async (req: Request, res: Response) => {
      const userId = req.session?.user?.id;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      try {
        const user = await this.prisma.users.findUnique({ where: { id: userId } });
        if (!user) return res.status(404).json({ error: "User not found" });

        const where = user.isAdmin ? {} : { ownerId: userId };
        const servers = await this.prisma.server.findMany({
          where,
          select: { UUID: true, name: true, description: true, status: true, owner: { select: { username: true } } },
          orderBy: { name: "asc" },
        });

        res.json({
          success: true,
          data: servers.map((s: any) => ({
            id: s.UUID, name: s.name, description: s.description, status: s.status, owner: s.owner?.username || "You",
          })),
        });
      } catch {
        res.status(500).json({ error: "Failed to get servers" });
      }
    });
  }

  async updateInstallationStatus(
    projectId: string,
    versionId: string,
    serverId: string,
    status: "completed" | "failed" | "blocked",
    error?: string
  ): Promise<void> {
    try {
      await this.ensureStatisticsTable();

      const result = await this.prisma.$executeRawUnsafe(
        `UPDATE ModrinthInstallation SET status = ?, error = ?, installedAt = ?
         WHERE projectId = ? AND serverId = ? AND (versionId = ? OR versionId IS NULL)
         ORDER BY id DESC LIMIT 1`,
        [status, error || null, new Date().toISOString(), projectId, serverId, versionId]
      );

      if (result === 0) {
        await this.logInstallationAttempt(projectId, "unknown", status, serverId, undefined, versionId, error);
      }
    } catch (e) {
      this.api.logger.error("Error updating installation status:", e);
    }
  }

  async logInstallationAttempt(
    projectId: string,
    projectType: string,
    status: "completed" | "failed" | "blocked" | "in_progress",
    serverId?: string,
    projectName?: string,
    versionId?: string,
    error?: string
  ): Promise<void> {
    try {
      if (!projectId || !projectType || !status) return;
      await this.ensureStatisticsTable();

      await this.prisma.$executeRawUnsafe(
        `INSERT INTO ModrinthInstallation (projectId, projectType, projectName, versionId, serverId, status, error, installedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [projectId, projectType, projectName || null, versionId || null, serverId || null, status, error || null, new Date().toISOString()]
      );
    } catch (e) {
      this.api.logger.error("Error logging installation attempt:", e);
    }
  }

  async getServerInstallations(serverId: string, limit = 10): Promise<any[]> {
    try {
      await this.ensureStatisticsTable();
      const rows = await this.prisma.$queryRaw`
        SELECT * FROM ModrinthInstallation
        WHERE serverId = ${serverId}
        ORDER BY installedAt DESC LIMIT ${limit}
      `;
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  async cleanupOldStatistics(): Promise<void> {
    try {
      await this.ensureStatisticsTable();
      await this.prisma.$executeRaw`
        DELETE FROM ModrinthInstallation
        WHERE id NOT IN (
          SELECT id FROM ModrinthInstallation ORDER BY installedAt DESC LIMIT 1000
        )
      `;
    } catch {}
  }

  private isAuthenticatedForServer = (serverIdParam = "id") => {
    return async (req: Request, res: Response, next: Function): Promise<void> => {
      const userId = req.session?.user?.id;
      if (!userId) { res.redirect("/login"); return; }

      try {
        const user = await this.prisma.users.findUnique({ where: { id: userId } });
        if (!user) { res.redirect("/login"); return; }
        if (user.isAdmin) { next(); return; }

        const serverId = req.params[serverIdParam];
        const server = await this.prisma.server.findUnique({ where: { UUID: serverId } });

        if (server?.ownerId === userId) { next(); return; }
        res.redirect("/");
      } catch {
        res.redirect("/");
      }
    };
  };

  private isAdmin = () => {
    return async (req: Request, res: Response, next: Function): Promise<void> => {
      const userId = req.session?.user?.id;
      if (!userId) { res.redirect("/login"); return; }

      try {
        const user = await this.prisma.users.findUnique({ where: { id: userId } });
        if (!user?.isAdmin) { res.status(403).json({ error: "Admin access required" }); return; }
        next();
      } catch {
        res.status(500).json({ error: "Authentication error" });
      }
    };
  };

  private async checkForServerInstallation(serverId: string): Promise<boolean> {
    try {
      if (!serverId) return true;
      const server = await this.prisma.server.findUnique({ where: { UUID: serverId } });
      return !!server;
    } catch {
      return true;
    }
  }

  private getStoreIcon(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" width="24" height="24" viewBox="0 0 24 24"><path d="M12.252.004a11.78 11.768 0 0 0-8.92 3.73a11 11 0 0 0-2.17 3.11a11.37 11.359 0 0 0-1.16 5.169c0 1.42.17 2.5.6 3.77c.24.759.77 1.899 1.17 2.529a12.3 12.298 0 0 0 8.85 5.639c.44.05 2.54.07 2.76.02c.2-.04.22.1-.26-1.7l-.36-1.37l-1.01-.06a8.5 8.489 0 0 1-5.18-1.8a5.3 5.3 0 0 1-1.3-1.26c0-.05.34-.28.74-.5a37.572 37.545 0 0 1 2.88-1.629c.03 0 .5.45 1.06.98l1 .97l2.07-.43l2.06-.43l1.47-1.47c.8-.8 1.48-1.5 1.48-1.52c0-.09-.42-1.63-.46-1.7c-.04-.06-.2-.03-1.02.18c-.53.13-1.2.3-1.45.4l-.48.15l-.53.53l-.53.53l-.93.1l-.93.07l-.52-.5a2.7 2.7 0 0 1-.96-1.7l-.13-.6l.43-.57c.68-.9.68-.9 1.46-1.1c.4-.1.65-.2.83-.33c.13-.099.65-.579 1.14-1.069l.9-.9l-.7-.7l-.7-.7l-1.95.54c-1.07.3-1.96.53-1.97.53c-.03 0-2.23 2.48-2.63 2.97l-.29.35l.28 1.03c.16.56.3 1.16.31 1.34l.03.3l-.34.23c-.37.23-2.22 1.3-2.84 1.63c-.36.2-.37.2-.44.1c-.08-.1-.23-.6-.32-1.03c-.18-.86-.17-2.75.02-3.73a8.84 8.84 0 0 1 7.9-6.93c.43-.03.77-.08.78-.1c.06-.17.5-2.999.47-3.039c-.01-.02-.1-.02-.2-.03Zm3.68.67c-.2 0-.3.1-.37.38c-.06.23-.46 2.42-.46 2.52c0 .04.1.11.22.16a8.51 8.499 0 0 1 2.99 2a8.38 8.379 0 0 1 2.16 3.449a6.9 6.9 0 0 1 .4 2.8c0 1.07 0 1.27-.1 1.73a9.4 9.4 0 0 1-1.76 3.769c-.32.4-.98 1.06-1.37 1.38c-.38.32-1.54 1.1-1.7 1.14c-.1.03-.1.06-.07.26c.03.18.64 2.56.7 2.78l.06.06a12.07 12.058 0 0 0 7.27-9.4c.13-.77.13-2.58 0-3.4a11.96 11.948 0 0 0-5.73-8.578c-.7-.42-2.05-1.06-2.25-1.06Z"/></svg>`;
  }
}

export default UIService;
