/**
 * =============================================================================
 * File: ui.ts
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
import { Router, Request, Response } from "express";
import path from "path";
import * as fs from "fs/promises";

interface AddonAPI {
  registerRoute: (path: string, router: Router) => void;
  logger: any;
  prisma: any;
  addonPath: string;
  viewsPath: string;
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

export class UIService {
  private api: AddonAPI;
  private prisma: any;
  private settingsCache: ModrinthSettings | null = null;
  private cacheExpiry: number = 0;

  constructor(api: AddonAPI) {
    this.api = api;
    this.prisma = api.prisma;
  }

  private async getGlobalSettings(): Promise<any> {
    try {
      const globalSettings = await this.prisma.settings
        .findFirst()
        .catch(() => null);
      return (
        globalSettings || {
          title: "Control Panel",
          logo: "/assets/logo.png",
          theme: "dark",
        }
      );
    } catch (error) {
      this.api.logger.error("Error getting global settings:", error);
      return {
        title: "Control Panel",
        logo: "/assets/logo.png",
        theme: "dark",
      };
    }
  }

  /**
   * Get Modrinth-specific settings from file with caching
   */
  private async getModrinthSettings(): Promise<ModrinthSettings> {
    const now = Date.now();

    // Return cached settings if still valid
    if (this.settingsCache && now < this.cacheExpiry) {
      return this.settingsCache;
    }

    const settingsPath = path.join(
      this.api.addonPath,
      "modrinth-settings.json"
    );

    try {
      // Debug file system first
      // await this.debugFileSystem();

      const data = await fs.readFile(settingsPath, "utf8");
      const settings = JSON.parse(data);

      // Validate and create clean settings object
      const validatedSettings: ModrinthSettings = {
        modrinthInstallationWarning: Boolean(
          settings.modrinthInstallationWarning
        ),
        warningTitle:
          typeof settings.warningTitle === "string" &&
          settings.warningTitle.trim()
            ? settings.warningTitle
            : "Installation Temporarily Disabled",
        warningMessage:
          typeof settings.warningMessage === "string" &&
          settings.warningMessage.trim()
            ? settings.warningMessage
            : "Installations are temporarily disabled due to technical issues in the backend.",
        disabledProjectTypes: Array.isArray(settings.disabledProjectTypes)
          ? settings.disabledProjectTypes.filter(
              (type: any) => typeof type === "string" && type.trim()
            )
          : [],
        blockedProjects: Array.isArray(settings.blockedProjects)
          ? settings.blockedProjects.filter(
              (project: any) => typeof project === "string" && project.trim()
            )
          : [],
      };

      // Cache the validated settings
      this.settingsCache = validatedSettings;
      this.cacheExpiry = now + 30000;

      return validatedSettings;
    } catch (error) {
      this.api.logger.error("Error reading settings file:", error);

      // Return and create default settings
      const defaultSettings: ModrinthSettings = {
        modrinthInstallationWarning: false,
        warningTitle: "Installation Temporarily Disabled",
        warningMessage:
          "Installations are temporarily disabled due to technical issues in the backend.",
        disabledProjectTypes: [],
        blockedProjects: [],
      };

      // Try to create the default settings file
      try {
        await this.saveModrinthSettings(defaultSettings);
        this.settingsCache = defaultSettings;
        this.cacheExpiry = now + 30000;
      } catch (saveError) {
        this.api.logger.error(
          "Failed to create default settings file:",
          saveError
        );
      }

      return defaultSettings;
    }
  }

  /**
   * Clear settings cache
   */
  private clearSettingsCache(): void {
    this.settingsCache = null;
    this.cacheExpiry = 0;
  }

  /**
   * Save Modrinth-specific settings to file
   */
  private async saveModrinthSettings(
    settings: ModrinthSettings
  ): Promise<void> {
    const settingsPath = path.join(
      this.api.addonPath,
      "modrinth-settings.json"
    );

    try {
      this.api.logger.info("Saving settings to:", settingsPath);

      // Ensure the addon directory exists
      await fs.mkdir(this.api.addonPath, { recursive: true });

      // Validate and clean settings
      const cleanSettings: ModrinthSettings = {
        modrinthInstallationWarning: Boolean(
          settings.modrinthInstallationWarning
        ),
        warningTitle:
          typeof settings.warningTitle === "string" &&
          settings.warningTitle.trim()
            ? settings.warningTitle.trim()
            : "Installation Temporarily Disabled",
        warningMessage:
          typeof settings.warningMessage === "string" &&
          settings.warningMessage.trim()
            ? settings.warningMessage.trim()
            : "Installations are temporarily disabled due to technical issues in the backend.",
        disabledProjectTypes: Array.isArray(settings.disabledProjectTypes)
          ? [
              ...new Set(
                settings.disabledProjectTypes
                  .filter(
                    (type) => typeof type === "string" && type.trim().length > 0
                  )
                  .map((type) => type.trim())
              ),
            ]
          : [],
        blockedProjects: Array.isArray(settings.blockedProjects)
          ? [
              ...new Set(
                settings.blockedProjects
                  .filter(
                    (project) =>
                      typeof project === "string" && project.trim().length > 0
                  )
                  .map((project) => project.trim())
              ),
            ]
          : [],
      };

      this.api.logger.info("Clean settings to write:", cleanSettings);

      // Write settings to file
      const jsonContent = JSON.stringify(cleanSettings, null, 2);
      await fs.writeFile(settingsPath, jsonContent, "utf8");

      // Verify the file was written
      const fileExists = await fs
        .access(settingsPath)
        .then(() => true)
        .catch(() => false);
      if (!fileExists) {
        throw new Error("File was not created after write operation");
      }

      // Read back to verify content
      const writtenContent = await fs.readFile(settingsPath, "utf8");
      const parsedContent = JSON.parse(writtenContent);

      this.api.logger.info("Verified written content:", parsedContent);

      // Clear cache
      this.clearSettingsCache();

      this.api.logger.info(
        "Modrinth settings saved and verified successfully",
        {
          path: settingsPath,
          warningEnabled: cleanSettings.modrinthInstallationWarning,
          disabledTypes: cleanSettings.disabledProjectTypes,
          blockedProjects: cleanSettings.blockedProjects.length,
        }
      );
    } catch (error) {
      this.api.logger.error("Error saving Modrinth settings:", {
        error: error instanceof Error ? error.message : error,
        stack: error instanceof Error ? error.stack : undefined,
        settingsPath,
        addonPath: this.api.addonPath,
      });
      throw error;
    }
  }
  /*
private async debugFileSystem(): Promise<void> {
  try {
    const settingsPath = path.join(this.api.addonPath, 'modrinth-settings.json');
    
    this.api.logger.info('File system debug info:', {
      addonPath: this.api.addonPath,
      settingsPath: settingsPath,
      cwd: process.cwd()
    });
    
    // Check if addon directory exists and is writable
    try {
      await fs.access(this.api.addonPath, fs.constants.F_OK | fs.constants.W_OK);
   //   this.api.logger.info('Addon directory exists and is writable');
    } catch (error) {
      this.api.logger.error('Addon directory access issue:', error);
      
      // Try to create it
      try {
        await fs.mkdir(this.api.addonPath, { recursive: true });
        this.api.logger.info('Created addon directory');
      } catch (mkdirError) {
        this.api.logger.error('Failed to create addon directory:', mkdirError);
      }
    }
    
    // Check if settings file exists
    try {
      const stats = await fs.stat(settingsPath);
      this.api.logger.info('Settings file stats:', {
        size: stats.size,
        modified: stats.mtime,
        isFile: stats.isFile()
      });
    } catch (error) {
      this.api.logger.info('Settings file does not exist yet');
    }
    
  } catch (error) {
    this.api.logger.error('Debug filesystem error:', error);
  }
}
*/
  private async ensureStatisticsTable(): Promise<void> {
    try {
      // This should match the table created in index.ts
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
    } catch (error) {
      this.api.logger.error("Error ensuring statistics table:", error);
    }
  }

  /**
   * Get installation statistics using raw SQL queries
   */
  private async getInstallationStatistics(): Promise<any> {
    try {
      await this.ensureStatisticsTable();

      // Get total completed installations
      const totalResult = await this.prisma.$queryRawUnsafe(`
        SELECT COUNT(*) as count FROM ModrinthInstallation WHERE status = 'completed'
      `);
      const totalInstallations = Number(totalResult[0]?.count || 0);

      // Get unique active projects
      const projectsResult = await this.prisma.$queryRawUnsafe(`
        SELECT COUNT(DISTINCT projectId) as count FROM ModrinthInstallation WHERE status = 'completed'
      `);
      const activeProjects = Number(projectsResult[0]?.count || 0);

      // Get blocked/failed installations
      const blockedResult = await this.prisma.$queryRawUnsafe(`
        SELECT COUNT(*) as count FROM ModrinthInstallation WHERE status IN ('failed', 'blocked')
      `);
      const blockedInstallations = Number(blockedResult[0]?.count || 0);

      return {
        totalInstallations,
        activeProjects,
        blockedInstallations,
      };
    } catch (error) {
      this.api.logger.error("Error getting installation statistics:", error);
      return {
        totalInstallations: 0,
        activeProjects: 0,
        blockedInstallations: 0,
      };
    }
  }
  /**
   * Check if a project is blocked based on settings
   */
  async isProjectBlocked(
    projectId: string,
    projectType: string
  ): Promise<{
    blocked: boolean;
    reason: "type_disabled" | "project_blocked" | null;
  }> {
    try {
      const settings = await this.getModrinthSettings();

      // Check if project type is disabled first
      if (settings.disabledProjectTypes.includes(projectType)) {
        return { blocked: true, reason: "type_disabled" };
      }

      // Check if specific project is blocked
      if (settings.blockedProjects.includes(projectId)) {
        return { blocked: true, reason: "project_blocked" };
      }

      return { blocked: false, reason: null };
    } catch (error) {
      this.api.logger.error("Error checking if project is blocked:", error);
      return { blocked: false, reason: null };
    }
  }

  /**
   * Filter projects based on disabled settings
   */
  async filterProjects(projects: any[]): Promise<any[]> {
    if (!Array.isArray(projects) || projects.length === 0) {
      return projects;
    }

    try {
      const settings = await this.getModrinthSettings();

      const filtered = projects.filter((project) => {
        // Check if project type is disabled
        if (settings.disabledProjectTypes.includes(project.project_type)) {
          this.api.logger.debug(
            `Filtering out project ${project.project_id || project.id} - type ${
              project.project_type
            } is disabled`
          );
          return false;
        }

        // Check if specific project is blocked
        const projectId = project.project_id || project.id;
        if (projectId && settings.blockedProjects.includes(projectId)) {
          this.api.logger.debug(
            `Filtering out project ${projectId} - project is blocked`
          );
          return false;
        }

        return true;
      });

      
      return filtered;
    } catch (error) {
      this.api.logger.error("Error filtering projects:", error);
      // Return original projects on error to avoid breaking the UI
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

    //  this.api.logger.info('Modrinth UI setup complete');
  }

  setupRoutes(router: Router, searchService: any): void {
    this.api.registerRoute("/modrinth", router);

    // CRITICAL: Add body parsing middleware
    const express = require("express");
    router.use(express.json());
    router.use(express.urlencoded({ extended: true }));
    // Main browse page
    router.get("/", async (req: Request, res: Response) => {
      const userId = req.session?.user?.id;
      if (!userId) {
        res.redirect("/login");
        return;
      }

      try {
        const query = String(req.query.q || "").trim();
        const type = String(req.query.type || "all");
        const page = Math.max(1, parseInt(req.query.page as string) || 1);

        const [user, globalSettings, modrinthSettings] = await Promise.all([
          this.prisma.users.findUnique({ where: { id: userId } }),
          this.getGlobalSettings(),
          this.getModrinthSettings(),
        ]);

        // Get raw search results
        const results = query
          ? await searchService.searchModrinth(query, type, page)
          : await searchService.searchModrinth("", "modpack", page);

        // Apply filtering based on settings
        let filteredHits = [];
        if (results && results.hits) {
          filteredHits = await this.filterProjects(results.hits);
        }

        // Update results object with filtered data
        const filteredResults = {
          ...results,
          hits: filteredHits,
          total_hits: filteredHits.length,
        };

        res.render(path.join(this.api.viewsPath, "browse.ejs"), {
          title: "Modrinth Store",
          user,
          req,
          settings: globalSettings,
          modrinthSettings,
          query,
          type,
          page,
          results: filteredResults,
          totalPages: Math.ceil(filteredHits.length / 20),
          mods: filteredHits || [],
          featuredMods: (filteredHits || []).slice(0, 5),
          components: {
            header: this.api.getComponentPath("views/components/header"),
            template: this.api.getComponentPath("views/components/template"),
            footer: this.api.getComponentPath("views/components/footer"),
          },
        });
      } catch (error) {
        this.api.logger.error("Error in browse page:", error);
        res.status(500).json({ error: "Failed to load page" });
      }
    });

    // Server-specific browse page
    router.get(
      "/:id/modrinth",
      this.isAuthenticatedForServer("id"),
      async (req: Request, res: Response) => {
        const userId = req.session?.user?.id;
        const serverId = req.params?.id;

        if (!serverId) {
          res.status(400).json({ error: "Server ID is required" });
          return;
        }

        try {
          const [
            user,
            server,
            installations,
            globalSettings,
            modrinthSettings,
          ] = await Promise.all([
            this.prisma.users.findUnique({ where: { id: userId } }),
            this.prisma.server.findUnique({
              where: { UUID: serverId },
              include: { node: true, image: true, owner: true },
            }),
            this.prisma
              .$queryRaw`SELECT * FROM ModrinthInstallation WHERE serverId = ${serverId} ORDER BY id DESC LIMIT 10`,
            this.getGlobalSettings(),
            this.getModrinthSettings(),
          ]);

          if (!user || !server) {
            res.status(404).json({ error: "User or server not found" });
            return;
          }

          res.render(path.join(this.api.viewsPath, "browse.ejs"), {
            user,
            req,
            server,
            installations: installations || [],
            settings: globalSettings,
            modrinthSettings,
            features: JSON.parse(server.image?.info || "{}").features || [],
            installed: await this.checkForServerInstallation(serverId),
            components: {
              header: this.api.getComponentPath("views/components/header"),
              template: this.api.getComponentPath("views/components/template"),
              footer: this.api.getComponentPath("views/components/footer"),
              serverHeader: this.api.getComponentPath(
                "views/components/serverHeader"
              ),
              installHeader: this.api.getComponentPath(
                "views/components/installHeader"
              ),
              serverTemplate: this.api.getComponentPath(
                "views/components/serverTemplate"
              ),
            },
          });
        } catch (error) {
          this.api.logger.error("Error in server page:", error);
          res.status(500).json({ error: "Failed to load page" });
        }
      }
    );

    // Project detail page
    router.get("/project/:id", async (req: Request, res: Response) => {
      const userId = req.session?.user?.id;
      if (!userId) {
        res.redirect("/login");
        return;
      }

      try {
        const { id } = req.params;
        if (!id) {
          res.status(400).json({ error: "Project ID is required" });
          return;
        }

        const [user, globalSettings, modrinthSettings, project, versions] =
          await Promise.all([
            this.prisma.users.findUnique({ where: { id: userId } }),
            this.getGlobalSettings(),
            this.getModrinthSettings(),
            searchService.getProject(id),
            searchService.getProjectVersions(id),
          ]);

        if (!user || !project) {
          res.status(404).json({ error: "User or project not found" });
          return;
        }

        // Check if project should be blocked
        const blockStatus = await this.isProjectBlocked(
          project.id,
          project.project_type
        );

        res.render(path.join(this.api.viewsPath, "project.ejs"), {
          title: `${project.title} - Modrinth`,
          user,
          req,
          settings: globalSettings,
          modrinthSettings,
          project,
          versions: versions || [],
          isProjectBlocked: blockStatus.blocked,
          blockReason: blockStatus.reason,
          components: {
            header: this.api.getComponentPath("views/components/header"),
            template: this.api.getComponentPath("views/components/template"),
            footer: this.api.getComponentPath("views/components/footer"),
          },
        });
      } catch (error) {
        this.api.logger.error("Error in project page:", error);
        res.status(500).render(path.join(this.api.viewsPath, "error.ejs"), {
          title: "Error - Modrinth",
          user: req.session?.user,
          req,
          error: "Failed to load project",
          settings: await this.getGlobalSettings().catch(() => ({})),
          components: {
            header: this.api.getComponentPath("views/components/header"),
            template: this.api.getComponentPath("views/components/template"),
            footer: this.api.getComponentPath("views/components/footer"),
          },
        });
      }
    });
    // Admin config page (GET)
    router.get(
      "/admin/config",
      this.isAdmin(),
      async (req: Request, res: Response) => {
        try {
          const [globalSettings, modrinthSettings] = await Promise.all([
            this.getGlobalSettings(),
            this.getModrinthSettings(),
          ]);

          // this.api.logger.info('Loading admin config page');

          res.render(path.join(this.api.viewsPath, "admin-config.ejs"), {
            title: "Modrinth Configuration - Admin",
            user: req.session?.user,
            req,
            settings: globalSettings,
            modrinthSettings,
            components: {
              header: this.api.getComponentPath("views/components/header"),
              template: this.api.getComponentPath("views/components/template"),
              footer: this.api.getComponentPath("views/components/footer"),
            },
          });
        } catch (error) {
          this.api.logger.error("Error in admin config page:", error);
          res.status(500).json({ error: "Failed to load admin configuration" });
        }
      }
    );

    // Admin config update (POST) - your existing route with the fix
    router.post(
      "/admin/config",
      this.isAdmin(),
      async (req: Request, res: Response) => {
        try {
          this.api.logger.info("Received admin config JSON update:", {
            body: req.body,
            contentType: req.get("content-type"),
          });

          // Validate that we received JSON
          if (!req.body || typeof req.body !== "object") {
            return res.status(400).json({
              success: false,
              error: "Invalid JSON payload. Expected object.",
            });
          }

          // Validate required fields and types
          const {
            modrinthInstallationWarning,
            warningTitle,
            warningMessage,
            disabledProjectTypes,
            blockedProjects,
          } = req.body;

          const errors: string[] = [];

          // Type validation
          if (typeof modrinthInstallationWarning !== "boolean") {
            errors.push("modrinthInstallationWarning must be a boolean");
          }

          if (typeof warningTitle !== "string") {
            errors.push("warningTitle must be a string");
          }

          if (typeof warningMessage !== "string") {
            errors.push("warningMessage must be a string");
          }

          if (!Array.isArray(disabledProjectTypes)) {
            errors.push("disabledProjectTypes must be an array");
          } else {
            disabledProjectTypes.forEach((type: any, index: number) => {
              if (typeof type !== "string") {
                errors.push(`disabledProjectTypes[${index}] must be a string`);
              }
            });
          }

          if (!Array.isArray(blockedProjects)) {
            errors.push("blockedProjects must be an array");
          } else {
            blockedProjects.forEach((project: any, index: number) => {
              if (typeof project !== "string") {
                errors.push(`blockedProjects[${index}] must be a string`);
              }
            });
          }

          if (errors.length > 0) {
            return res.status(400).json({
              success: false,
              error: `Validation errors: ${errors.join(", ")}`,
            });
          }

          // Clean and prepare settings
          const settingsToSave: ModrinthSettings = {
            modrinthInstallationWarning: Boolean(modrinthInstallationWarning),
            warningTitle:
              warningTitle && typeof warningTitle === "string"
                ? warningTitle.trim()
                : "Installation Temporarily Disabled",
            warningMessage:
              warningMessage && typeof warningMessage === "string"
                ? warningMessage.trim()
                : "Installations are temporarily disabled.",
            disabledProjectTypes: Array.isArray(disabledProjectTypes)
              ? [
                  ...new Set(
                    disabledProjectTypes
                      .filter(
                        (type) =>
                          typeof type === "string" && type.trim().length > 0
                      )
                      .map((type) => type.trim())
                  ),
                ]
              : [],
            blockedProjects: Array.isArray(blockedProjects)
              ? [
                  ...new Set(
                    blockedProjects
                      .filter(
                        (project) =>
                          typeof project === "string" &&
                          project.trim().length > 0
                      )
                      .map((project) => project.trim())
                  ),
                ]
              : [],
          };

          // Save settings
          await this.saveModrinthSettings(settingsToSave);

          this.api.logger.info(
            "Modrinth settings saved successfully via JSON editor:",
            {
              warningEnabled: settingsToSave.modrinthInstallationWarning,
              disabledTypes: settingsToSave.disabledProjectTypes,
              blockedProjectsCount: settingsToSave.blockedProjects.length,
            }
          );

          res.json({
            success: true,
            message: "Configuration saved successfully from JSON editor",
            settings: settingsToSave,
          });
        } catch (error) {
          this.api.logger.error(
            "Error saving admin config from JSON editor:",
            error
          );
          res.status(500).json({
            success: false,
            error: "Failed to save configuration. Please check server logs.",
          });
        }
      }
    );

    router.get(
      "/admin/config",
      this.isAdmin(),
      async (req: Request, res: Response) => {
        try {
          const [globalSettings, modrinthSettings] = await Promise.all([
            this.getGlobalSettings(),
            this.getModrinthSettings(),
          ]);

          this.api.logger.info("Loading JSON editor admin config page");

          res.render(path.join(this.api.viewsPath, "admin-config.ejs"), {
            title: "Modrinth Configuration - Admin",
            user: req.session?.user,
            req,
            settings: globalSettings,
            modrinthSettings,
            components: {
              header: this.api.getComponentPath("views/components/header"),
              template: this.api.getComponentPath("views/components/template"),
              footer: this.api.getComponentPath("views/components/footer"),
            },
          });
        } catch (error) {
          this.api.logger.error(
            "Error loading JSON editor admin config page:",
            error
          );
          res.status(500).json({
            success: false,
            error: "Failed to load admin configuration page",
          });
        }
      }
    );

    // API endpoints
    router.get(
      "/api/config",
      this.isAdmin(),
      async (req: Request, res: Response) => {
        try {
          const modrinthSettings = await this.getModrinthSettings();
          res.json({ success: true, data: modrinthSettings });
        } catch (error) {
          this.api.logger.error("Error getting config:", error);
          res.status(500).json({ error: "Failed to get configuration" });
        }
      }
    );

    router.get(
      "/api/statistics",
      this.isAdmin(),
      async (req: Request, res: Response) => {
        try {
          const statistics = await this.getInstallationStatistics();
          res.json({ success: true, data: statistics });
        } catch (error) {
          this.api.logger.error("Error getting statistics:", error);
          res.status(500).json({ error: "Failed to get statistics" });
        }
      }
    );

    // File status endpoint (was missing)
    router.get(
      "/api/file-status",
      this.isAdmin(),
      async (req: Request, res: Response) => {
        try {
          const settingsPath = path.join(
            this.api.addonPath,
            "modrinth-settings.json"
          );

          try {
            const stats = await fs.stat(settingsPath);
            res.json({
              success: true,
              data: {
                exists: true,
                size: stats.size,
                lastModified: stats.mtime,
                path: settingsPath,
              },
            });
          } catch (statError) {
            if ((statError as any).code === "ENOENT") {
              res.json({
                success: true,
                data: {
                  exists: false,
                  size: 0,
                  lastModified: null,
                  path: settingsPath,
                },
              });
            } else {
              throw statError;
            }
          }
        } catch (error) {
          this.api.logger.error("Error getting file status:", error);
          res.status(500).json({ error: "Failed to get file status" });
        }
      }
    );

    // Settings endpoint for JSON viewing (was missing)
    router.get(
      "/api/settings",
      this.isAdmin(),
      async (req: Request, res: Response) => {
        try {
          const settings = await this.getModrinthSettings();
          res.json(settings);
        } catch (error) {
          this.api.logger.error("Error getting settings for JSON view:", error);
          res.status(500).json({ error: "Failed to get settings" });
        }
      }
    );

    router.get(
      "/api/project/:id/status",
      async (req: Request, res: Response) => {
        try {
          const { id } = req.params;
          const { type } = req.query;

          if (!id || !type) {
            res.status(400).json({ error: "Project ID and type are required" });
            return;
          }

          const blockStatus = await this.isProjectBlocked(id, type as string);

          res.json({
            success: true,
            blocked: blockStatus.blocked,
            reason: blockStatus.reason,
            projectTypeDisabled: blockStatus.reason === "type_disabled",
            projectBlocked: blockStatus.reason === "project_blocked",
          });
        } catch (error) {
          this.api.logger.error("Error checking project status:", error);
          res.status(500).json({ error: "Failed to check project status" });
        }
      }
    );

    router.get("/api/servers", async (req: Request, res: Response) => {
      const userId = req.session?.user?.id;
      if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }

      try {
        const user = await this.prisma.users.findUnique({
          where: { id: userId },
        });

        const servers = user.isAdmin
          ? await this.prisma.server.findMany({
              select: {
                UUID: true,
                name: true,
                description: true,
                status: true,
                owner: { select: { username: true } },
              },
              orderBy: { name: "asc" },
            })
          : await this.prisma.server.findMany({
              where: { ownerId: userId },
              select: {
                UUID: true,
                name: true,
                description: true,
                status: true,
              },
              orderBy: { name: "asc" },
            });

        const formattedServers = servers.map((server: any) => ({
          id: server.UUID,
          name: server.name,
          description: server.description,
          status: server.status,
          owner: server.owner?.username || "You",
        }));

        res.json({ success: true, data: formattedServers });
      } catch (error) {
        this.api.logger.error("Error getting servers:", error);
        res.status(500).json({ error: "Failed to get servers" });
      }
    });
  }

  /**
   * Update installation status
   */
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
        `
        UPDATE ModrinthInstallation 
        SET status = ?, error = ?, installedAt = ?
        WHERE projectId = ? AND serverId = ? 
        AND (versionId = ? OR versionId IS NULL)
        ORDER BY id DESC LIMIT 1
      `,
        [
          status,
          error || null,
          new Date().toISOString(),
          projectId,
          serverId,
          versionId,
        ]
      );

      // If no existing record was updated, create a new one
      if (result === 0) {
        await this.logInstallationAttempt(
          projectId,
          "unknown",
          status,
          serverId,
          undefined,
          versionId,
          error
        );
      }

      this.api.logger.debug("Installation status updated:", {
        projectId,
        versionId,
        status,
      });
    } catch (error) {
      this.api.logger.error("Error updating installation status:", error);
    }
  }

  private isAuthenticatedForServer = (serverIdParam: string = "id") => {
    return async (
      req: Request,
      res: Response,
      next: Function
    ): Promise<void> => {
      const userId = req.session?.user?.id;
      if (!userId) {
        res.redirect("/login");
        return;
      }

      try {
        const user = await this.prisma.users.findUnique({
          where: { id: userId },
        });
        if (!user) {
          res.redirect("/login");
          return;
        }

        if (user.isAdmin) {
          next();
          return;
        }

        const serverId = req.params[serverIdParam];
        const server = await this.prisma.server.findUnique({
          where: { UUID: serverId },
          include: { owner: true },
        });

        if (server?.ownerId === userId) {
          next();
          return;
        }

        res.redirect("/");
      } catch (error) {
        this.api.logger.error("Error in server authentication:", error);
        res.redirect("/");
      }
    };
  };

  private isAdmin = () => {
    return async (
      req: Request,
      res: Response,
      next: Function
    ): Promise<void> => {
      const userId = req.session?.user?.id;
      if (!userId) {
        res.redirect("/login");
        return;
      }

      try {
        const user = await this.prisma.users.findUnique({
          where: { id: userId },
        });
        if (!user || !user.isAdmin) {
          res.status(403).json({ error: "Admin access required" });
          return;
        }
        next();
      } catch (error) {
        this.api.logger.error("Error in admin authentication:", error);
        res.status(500).json({ error: "Authentication error" });
      }
    };
  };

  private async checkForServerInstallation(serverId: string): Promise<boolean> {
    try {
      if (!serverId) return true;
      const server = await this.prisma.server.findUnique({
        where: { UUID: serverId },
      });
      return !!server;
    } catch (error) {
      this.api.logger.error("Error checking server installation:", error);
      return true;
    }
  }

  /**
   * Log installation attempt using raw SQL
   */
  /**
   * Log installation attempt with proper error handling
   */
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
      if (!projectId || !projectType || !status) {
        this.api.logger.warn(
          "Invalid parameters for logging installation attempt"
        );
        return;
      }

      await this.ensureStatisticsTable();

      await this.prisma.$executeRawUnsafe(
        `
        INSERT INTO ModrinthInstallation (
          projectId, projectType, projectName, versionId, serverId, status, error, installedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          projectId,
          projectType,
          projectName || null,
          versionId || null,
          serverId || null,
          status,
          error || null,
          new Date().toISOString(),
        ]
      );

      this.api.logger.info("Installation attempt logged:", {
        projectId,
        projectType,
        status,
        serverId,
        hasError: !!error,
      });
    } catch (dbError) {
      this.api.logger.error("Error logging installation attempt:", {
        error: dbError,
        projectId,
        projectType,
        status,
      });
    }
  }

  /**
   * Get recent installations for a server
   */
  async getServerInstallations(
    serverId: string,
    limit: number = 10
  ): Promise<any[]> {
    try {
      await this.ensureStatisticsTable();

      const installations = await this.prisma.$queryRaw`
      SELECT * FROM ModrinthInstallation 
      WHERE serverId = ${serverId} 
      ORDER BY installedAt DESC 
      LIMIT ${limit}
    `;

      return Array.isArray(installations) ? installations : [];
    } catch (error) {
      this.api.logger.error("Error getting server installations:", error);
      return [];
    }
  }

  /**
   * Clean up old statistics entries (keep last 1000 entries)
   */
  async cleanupOldStatistics(): Promise<void> {
    try {
      await this.ensureStatisticsTable();

      await this.prisma.$executeRaw`
      DELETE FROM ModrinthInstallation 
      WHERE id NOT IN (
        SELECT id FROM ModrinthInstallation 
        ORDER BY installedAt DESC 
        LIMIT 1000
      )
    `;

      this.api.logger.info("Old statistics entries cleaned up");
    } catch (error) {
      this.api.logger.error("Error cleaning up old statistics:", error);
    }
  }

  private getStoreIcon(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" width="24" height="24" viewBox="0 0 24 24">
  <path d="M12.252.004a11.78 11.768 0 0 0-8.92 3.73a11 11 0 0 0-2.17 3.11a11.37 11.359 0 0 0-1.16 5.169c0 1.42.17 2.5.6 3.77c.24.759.77 1.899 1.17 2.529a12.3 12.298 0 0 0 8.85 5.639c.44.05 2.54.07 2.76.02c.2-.04.22.1-.26-1.7l-.36-1.37l-1.01-.06a8.5 8.489 0 0 1-5.18-1.8a5.3 5.3 0 0 1-1.3-1.26c0-.05.34-.28.74-.5a37.572 37.545 0 0 1 2.88-1.629c.03 0 .5.45 1.06.98l1 .97l2.07-.43l2.06-.43l1.47-1.47c.8-.8 1.48-1.5 1.48-1.52c0-.09-.42-1.63-.46-1.7c-.04-.06-.2-.03-1.02.18c-.53.13-1.2.3-1.45.4l-.48.15l-.53.53l-.53.53l-.93.1l-.93.07l-.52-.5a2.7 2.7 0 0 1-.96-1.7l-.13-.6l.43-.57c.68-.9.68-.9 1.46-1.1c.4-.1.65-.2.83-.33c.13-.099.65-.579 1.14-1.069l.9-.9l-.7-.7l-.7-.7l-1.95.54c-1.07.3-1.96.53-1.97.53c-.03 0-2.23 2.48-2.63 2.97l-.29.35l.28 1.03c.16.56.3 1.16.31 1.34l.03.3l-.34.23c-.37.23-2.22 1.3-2.84 1.63c-.36.2-.37.2-.44.1c-.08-.1-.23-.6-.32-1.03c-.18-.86-.17-2.75.02-3.73a8.84 8.84 0 0 1 7.9-6.93c.43-.03.77-.08.78-.1c.06-.17.5-2.999.47-3.039c-.01-.02-.1-.02-.2-.03Zm3.68.67c-.2 0-.3.1-.37.38c-.06.23-.46 2.42-.46 2.52c0 .04.1.11.22.16a8.51 8.499 0 0 1 2.99 2a8.38 8.379 0 0 1 2.16 3.449a6.9 6.9 0 0 1 .4 2.8c0 1.07 0 1.27-.1 1.73a9.4 9.4 0 0 1-1.76 3.769c-.32.4-.98 1.06-1.37 1.38c-.38.32-1.54 1.1-1.7 1.14c-.1.03-.1.06-.07.26c.03.18.64 2.56.7 2.78l.06.06a12.07 12.058 0 0 0 7.27-9.4c.13-.77.13-2.58 0-3.4a11.96 11.948 0 0 0-5.73-8.578c-.7-.42-2.05-1.06-2.25-1.06Z"/>
</svg> `;
  }
}
export default UIService;
