/**
 * =============================================================================
 * File: settingsUtils.ts
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
import * as fs from "fs/promises";
import * as path from "path";

export interface ModrinthSettings {
  modrinthInstallationWarning: boolean;
  warningTitle: string;
  warningMessage: string;
  disabledProjectTypes: string[];
  blockedProjects: string[];
}

export class ModrinthSettingsManager {
  private settingsPath: string;
  private logger: any;

  constructor(addonPath: string, logger: any) {
    this.settingsPath = path.join(addonPath, "modrinth-settings.json");
    this.logger = logger;
  }

  /**
   * Get default settings structure
   */
  private getDefaultSettings(): ModrinthSettings {
    return {
      modrinthInstallationWarning: false,
      warningTitle: "Installation Temporarily Disabled",
      warningMessage:
        "Installations are temporarily disabled due to technical issues in the backend.",
      disabledProjectTypes: [],
      blockedProjects: [],
    };
  }

  /**
   * Load settings from file
   */
  async loadSettings(): Promise<ModrinthSettings> {
    try {
      const data = await fs.readFile(this.settingsPath, "utf8");
      const settings = JSON.parse(data);

      // Validate and merge with defaults
      const defaultSettings = this.getDefaultSettings();
      return {
        modrinthInstallationWarning: Boolean(
          settings.modrinthInstallationWarning ??
            defaultSettings.modrinthInstallationWarning
        ),
        warningTitle: settings.warningTitle || defaultSettings.warningTitle,
        warningMessage:
          settings.warningMessage || defaultSettings.warningMessage,
        disabledProjectTypes: Array.isArray(settings.disabledProjectTypes)
          ? settings.disabledProjectTypes
          : defaultSettings.disabledProjectTypes,
        blockedProjects: Array.isArray(settings.blockedProjects)
          ? settings.blockedProjects
          : defaultSettings.blockedProjects,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.logger.info("Settings file not found, creating with defaults");
        const defaultSettings = this.getDefaultSettings();
        await this.saveSettings(defaultSettings);
        return defaultSettings;
      } else {
        this.logger.error("Error reading settings file:", error);
        return this.getDefaultSettings();
      }
    }
  }

  /**
   * Save settings to file
   */
  async saveSettings(settings: ModrinthSettings): Promise<void> {
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });

      // Clean and validate settings
      const cleanSettings: ModrinthSettings = {
        modrinthInstallationWarning: Boolean(
          settings.modrinthInstallationWarning
        ),
        warningTitle:
          settings.warningTitle || "Installation Temporarily Disabled",
        warningMessage:
          settings.warningMessage ||
          "Installations are temporarily disabled due to technical issues in the backend.",
        disabledProjectTypes: Array.isArray(settings.disabledProjectTypes)
          ? settings.disabledProjectTypes.filter(
              (type) => typeof type === "string" && type.trim().length > 0
            )
          : [],
        blockedProjects: Array.isArray(settings.blockedProjects)
          ? settings.blockedProjects.filter(
              (project) =>
                typeof project === "string" && project.trim().length > 0
            )
          : [],
      };

      // Write settings to file with pretty formatting
      await fs.writeFile(
        this.settingsPath,
        JSON.stringify(cleanSettings, null, 2),
        "utf8"
      );
      this.logger.info("Modrinth settings saved successfully");
    } catch (error) {
      this.logger.error("Error saving settings file:", error);
      throw error;
    }
  }

  /**
   * Check if a project type is disabled
   */
  async isProjectTypeDisabled(projectType: string): Promise<boolean> {
    try {
      const settings = await this.loadSettings();
      return settings.disabledProjectTypes.includes(projectType);
    } catch (error) {
      this.logger.error("Error checking if project type is disabled:", error);
      return false;
    }
  }

  /**
   * Check if a specific project is blocked
   */
  async isProjectBlocked(projectId: string): Promise<boolean> {
    try {
      const settings = await this.loadSettings();
      return settings.blockedProjects.includes(projectId);
    } catch (error) {
      this.logger.error("Error checking if project is blocked:", error);
      return false;
    }
  }

  /**
   * Check if a project is blocked (either by type or specific ID)
   */
  async isProjectDisabled(
    projectId: string,
    projectType: string
  ): Promise<{
    disabled: boolean;
    reason: "type_disabled" | "project_blocked" | null;
  }> {
    try {
      const settings = await this.loadSettings();

      if (settings.disabledProjectTypes.includes(projectType)) {
        return { disabled: true, reason: "type_disabled" };
      }

      if (settings.blockedProjects.includes(projectId)) {
        return { disabled: true, reason: "project_blocked" };
      }

      return { disabled: false, reason: null };
    } catch (error) {
      this.logger.error("Error checking if project is disabled:", error);
      return { disabled: false, reason: null };
    }
  }

  /**
   * Filter a list of projects based on current settings
   */
  async filterProjects(projects: any[]): Promise<any[]> {
    if (!Array.isArray(projects) || projects.length === 0) {
      return projects;
    }

    try {
      const settings = await this.loadSettings();

      return projects.filter((project) => {
        // Check if project type is disabled
        if (settings.disabledProjectTypes.includes(project.project_type)) {
          return false;
        }

        // Check if specific project is blocked
        const projectId = project.project_id || project.id;
        if (projectId && settings.blockedProjects.includes(projectId)) {
          return false;
        }

        return true;
      });
    } catch (error) {
      this.logger.error("Error filtering projects:", error);
      // Return original projects on error to avoid breaking the UI
      return projects;
    }
  }

  /**
   * Add a project type to the disabled list
   */
  async disableProjectType(projectType: string): Promise<void> {
    const settings = await this.loadSettings();
    if (!settings.disabledProjectTypes.includes(projectType)) {
      settings.disabledProjectTypes.push(projectType);
      await this.saveSettings(settings);
    }
  }

  /**
   * Remove a project type from the disabled list
   */
  async enableProjectType(projectType: string): Promise<void> {
    const settings = await this.loadSettings();
    settings.disabledProjectTypes = settings.disabledProjectTypes.filter(
      (type) => type !== projectType
    );
    await this.saveSettings(settings);
  }

  /**
   * Add a project to the blocked list
   */
  async blockProject(projectId: string): Promise<void> {
    const settings = await this.loadSettings();
    if (!settings.blockedProjects.includes(projectId)) {
      settings.blockedProjects.push(projectId);
      await this.saveSettings(settings);
    }
  }

  /**
   * Remove a project from the blocked list
   */
  async unblockProject(projectId: string): Promise<void> {
    const settings = await this.loadSettings();
    settings.blockedProjects = settings.blockedProjects.filter(
      (id) => id !== projectId
    );
    await this.saveSettings(settings);
  }

  /**
   * Update warning settings
   */
  async updateWarningSettings(
    warningEnabled: boolean,
    title?: string,
    message?: string
  ): Promise<void> {
    const settings = await this.loadSettings();
    settings.modrinthInstallationWarning = warningEnabled;
    if (title !== undefined) settings.warningTitle = title;
    if (message !== undefined) settings.warningMessage = message;
    await this.saveSettings(settings);
  }

  /**
   * Reset settings to defaults
   */
  async resetToDefaults(): Promise<void> {
    const defaultSettings = this.getDefaultSettings();
    await this.saveSettings(defaultSettings);
  }

  /**
   * Get settings file path for debugging
   */
  getSettingsPath(): string {
    return this.settingsPath;
  }

  /**
   * Check if settings file exists
   */
  async settingsFileExists(): Promise<boolean> {
    try {
      await fs.access(this.settingsPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get settings file stats
   */
  async getSettingsStats(): Promise<{
    exists: boolean;
    size: number;
    lastModified: Date | null;
    path: string;
  }> {
    try {
      const stats = await fs.stat(this.settingsPath);
      return {
        exists: true,
        size: stats.size,
        lastModified: stats.mtime,
        path: this.settingsPath,
      };
    } catch {
      return {
        exists: false,
        size: 0,
        lastModified: null,
        path: this.settingsPath,
      };
    }
  }
}

// Export utility functions for direct use
export async function createDefaultSettingsFile(
  filePath: string
): Promise<void> {
  const defaultSettings: ModrinthSettings = {
    modrinthInstallationWarning: false,
    warningTitle: "Installation Temporarily Disabled",
    warningMessage:
      "Installations are temporarily disabled due to technical issues in the backend.",
    disabledProjectTypes: [],
    blockedProjects: [],
  };

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify(defaultSettings, null, 2),
    "utf8"
  );
}

export async function validateSettingsFile(filePath: string): Promise<{
  valid: boolean;
  errors: string[];
  settings?: ModrinthSettings;
}> {
  try {
    const data = await fs.readFile(filePath, "utf8");
    const settings = JSON.parse(data);
    const errors: string[] = [];

    // Validate structure
    if (typeof settings.modrinthInstallationWarning !== "boolean") {
      errors.push("modrinthInstallationWarning must be a boolean");
    }

    if (typeof settings.warningTitle !== "string") {
      errors.push("warningTitle must be a string");
    }

    if (typeof settings.warningMessage !== "string") {
      errors.push("warningMessage must be a string");
    }

    if (!Array.isArray(settings.disabledProjectTypes)) {
      errors.push("disabledProjectTypes must be an array");
    } else {
      settings.disabledProjectTypes.forEach((type: any, index: number) => {
        if (typeof type !== "string") {
          errors.push(`disabledProjectTypes[${index}] must be a string`);
        }
      });
    }

    if (!Array.isArray(settings.blockedProjects)) {
      errors.push("blockedProjects must be an array");
    } else {
      settings.blockedProjects.forEach((project: any, index: number) => {
        if (typeof project !== "string") {
          errors.push(`blockedProjects[${index}] must be a string`);
        }
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      settings: errors.length === 0 ? settings : undefined,
    };
  } catch (error) {
    return {
      valid: false,
      errors: [`Failed to parse JSON: ${(error as Error).message}`],
    };
  }
}
