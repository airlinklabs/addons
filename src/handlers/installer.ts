/**
 * =============================================================================
 * File: installer.ts
 * Author: g-flame
 * =============================================================================
 */
import path from "path";
import AdmZip from "adm-zip";
import { BackendLogic } from "./backend-logic";
import { ModpackIndex } from "../types/types";
import { progressTracker } from "./progress-tracker";

export class ModpackInstaller {
  private backendLogic: BackendLogic;

  constructor(private prisma: any, private logger: any, private config: any) {
    this.backendLogic = new BackendLogic(logger, config);
  }

  parseMrpackIndex(indexBuffer: Buffer): ModpackIndex {
    try {
      if (!indexBuffer?.length) throw new Error("Empty index buffer");

      const parsed = JSON.parse(indexBuffer.toString("utf8"));

      if (
        !parsed.formatVersion ||
        !parsed.game ||
        !parsed.name ||
        !parsed.dependencies
      ) {
        throw new Error("Invalid modpack index: missing required fields");
      }

      return {
        ...parsed,
        files: Array.isArray(parsed.files) ? parsed.files : [],
      };
    } catch (error: any) {
      this.logger?.error("Failed to parse modpack index:", error.message);
      throw new Error(`Failed to parse modpack index.json: ${error.message}`);
    }
  }

  async downloadModpackFile(
    fileInfo: any,
    serverId: string,
    projectId: string,
    getCachedData?: (key: string) => Promise<any>,
    setCachedData?: (key: string, data: any, duration?: number) => Promise<void>
  ): Promise<Buffer> {
    if (!fileInfo?.downloads?.length || !fileInfo.path) {
      throw new Error("Invalid file info");
    }

    const modName = path.basename(fileInfo.path);
    let lastError: Error | null = null;

    progressTracker.updateModProgress(
      serverId,
      projectId,
      modName,
      "downloading"
    );

    for (const url of fileInfo.downloads) {
      try {
        const expectedHash = fileInfo.hashes?.sha1 || fileInfo.hashes?.sha256;
        const buffer = await this.backendLogic.downloadAndCacheFile(
          url,
          modName,
          expectedHash,
          getCachedData,
          setCachedData
        );

        progressTracker.updateModProgress(
          serverId,
          projectId,
          modName,
          "completed",
          {
            downloadedSize: buffer.length,
          }
        );

        return buffer;
      } catch (error: any) {
        lastError = error;
      }
    }

    this.logger?.error(
      `All downloads failed for ${fileInfo.path}:`,
      lastError?.message
    );
    progressTracker.updateModProgress(serverId, projectId, modName, "failed", {
      error: lastError?.message || "Download failed",
    });

    throw new Error(
      `All downloads failed for ${fileInfo.path}: ${lastError?.message}`
    );
  }

  private async updateInstallationStatus(
    serverId: string,
    versionId: string,
    status: string,
    error?: string
  ): Promise<void> {
    const updateData = { status, error: error || null };

    try {
      const result = await this.prisma.$executeRaw`
        UPDATE ModrinthInstallations 
        SET status = ${updateData.status}, error = ${updateData.error}
        WHERE serverId = ${serverId} AND versionId = ${versionId}
      `;

      if (result === 0) {
        await this.prisma.$executeRaw`
          UPDATE ModrinthInstallation 
          SET status = ${updateData.status}, error = ${updateData.error}
          WHERE serverId = ${serverId} AND versionId = ${versionId}
        `;
      }
    } catch (dbError) {
      // Silent fail - don't interrupt installation
    }
  }

  private async createInstallationRecord(
    serverId: string,
    projectId: string,
    versionId: string,
    projectName: string,
    projectType: string,
    fileName: string
  ): Promise<void> {
    const status = "in_progress";

    try {
      await this.prisma.$executeRaw`
        INSERT INTO ModrinthInstallations 
          (serverId, projectId, versionId, projectName, projectType, fileName, status) 
        VALUES 
          (${serverId}, ${projectId}, ${versionId}, ${projectName}, ${projectType}, ${fileName}, ${status})
      `;
    } catch (error: any) {
      if (error.message.includes("ModrinthInstallations")) {
        await this.prisma.$executeRaw`
          INSERT INTO ModrinthInstallation 
            (serverId, projectId, versionId, projectType, status) 
          VALUES 
            (${serverId}, ${projectId}, ${versionId}, ${projectType}, ${status})
        `;
      } else {
        this.logger?.error(
          "Failed to create installation record:",
          error.message
        );
        throw new Error("Failed to create installation record");
      }
    }
  }

  private getFileDestination(
    filename: string,
    projectType: string,
    fileInfo?: any
  ): string {
    const ext = path.extname(filename).toLowerCase();
    const name = path.basename(filename).toLowerCase();

    const typeMap: Record<string, string> = {
      mod: "mods",
      plugin: "plugins",
      resourcepack: "resourcepacks",
      "resource-pack": "resourcepacks",
      datapack: "world/datapacks",
      "data-pack": "world/datapacks",
      shader: "shaderpacks",
      shaderpack: "shaderpacks",
      modpack: "/",
    };

    const destination = typeMap[projectType.toLowerCase()];
    if (destination) return destination;

    if (ext === ".jar") {
      const modPatterns = [
        "fabric",
        "forge",
        "quilt",
        "neoforge",
        "mod",
        "loader",
      ];
      const pluginPatterns = ["plugin", "bukkit", "spigot", "paper"];

      if (modPatterns.some((p) => name.includes(p))) return "mods";
      if (pluginPatterns.some((p) => name.includes(p))) return "plugins";
      if (!name.includes("server") && !name.includes("vanilla")) return "mods";
    }

    if (ext === ".zip") {
      if (name.includes("resource") || name.includes("texture"))
        return "resourcepacks";
      if (name.includes("shader") || name.includes("optifine"))
        return "shaderpacks";
      if (name.includes("datapack")) return "world/datapacks";
    }

    if (fileInfo?.path) {
      const filePath = fileInfo.path.toLowerCase();
      const pathChecks = [
        ["mods/", "mods"],
        ["plugins/", "plugins"],
        ["resourcepacks/", "resourcepacks"],
        ["shaderpacks/", "shaderpacks"],
        ["datapacks/", "world/datapacks"],
      ];

      for (const [prefix, dest] of pathChecks) {
        if (filePath.startsWith(prefix)) return dest;
      }
    }

    return "/";
  }

  private isModpack(projectType: string, filename: string): boolean {
    return (
      projectType.toLowerCase() === "modpack" ||
      filename.endsWith(".mrpack") ||
      (filename.endsWith(".zip") && projectType.toLowerCase() === "modpack")
    );
  }

  private shouldSkipFile(fileInfo: any): { skip: boolean; reason: string } {
    if (fileInfo.env?.server === "unsupported") {
      return { skip: true, reason: "client-only" };
    }

    if (
      fileInfo.env?.server === "optional" &&
      fileInfo.env?.client === "required"
    ) {
      const filename = fileInfo.path?.toLowerCase() || "";
      const clientMods = [
        "optifine",
        "sodium",
        "iris",
        "continuity",
        "rei",
        "jei",
        "journey-map",
        "journeymap",
        "xaero",
        "voxelmap",
        "jade",
      ];

      if (clientMods.some((mod) => filename.includes(mod))) {
        return { skip: true, reason: "client-side enhancement" };
      }
    }

    return { skip: false, reason: "" };
  }

  async installModpack(
    serverId: string,
    projectId: string,
    versionId: string,
    getCachedData?: (key: string) => Promise<any>,
    setCachedData?: (
      key: string,
      data: any,
      duration?: number
    ) => Promise<void>,
    makeModrinthRequest?: (endpoint: string, params?: any) => Promise<any>
  ): Promise<void> {
    let installationCreated = false;

    try {
      if (!makeModrinthRequest) {
        const error = "ModrinthAPI service required";
        progressTracker.addCriticalError(serverId, projectId, error);
        throw new Error(error);
      }

      progressTracker.updateStage(
        serverId,
        projectId,
        "initializing",
        "Fetching project information..."
      );

      const [project, version] = await Promise.all([
        makeModrinthRequest(`/project/${projectId}`),
        makeModrinthRequest(`/version/${versionId}`),
      ]);

      const primaryFile =
        version.files.find((f: any) => f.primary) || version.files[0];
      if (!primaryFile) {
        const error = "No files found in version";
        progressTracker.addCriticalError(serverId, projectId, error);
        throw new Error(error);
      }

      await this.createInstallationRecord(
        serverId,
        projectId,
        versionId,
        project.title,
        project.project_type,
        primaryFile.filename
      );
      installationCreated = true;

      const server = await this.prisma.server.findUnique({
        where: { UUID: serverId },
        include: { node: true },
      });

      if (!server) {
        const error = "Server not found in database";
        progressTracker.addCriticalError(serverId, projectId, error);
        throw new Error(error);
      }

      progressTracker.updateStage(
        serverId,
        projectId,
        "initializing",
        "Checking server status..."
      );

      const serverStatus = await this.backendLogic.getServerStatus({
        nodeAddress: server.node.address,
        nodePort: server.node.port,
        serverUUID: server.UUID,
        nodeKey: server.node.key,
      });

      if (serverStatus.daemonOffline) {
        const error = "Server daemon is offline - cannot install files";
        progressTracker.addCriticalError(serverId, projectId, error);
        throw new Error(error);
      }

      progressTracker.updateStage(
        serverId,
        projectId,
        "downloading",
        `Downloading ${primaryFile.filename}...`
      );
      await this.updateInstallationStatus(serverId, versionId, "downloading");

      // Install server JAR for modpacks
      if (this.isModpack(project.project_type, primaryFile.filename)) {
        const mcVersion = version.game_versions?.[0];
        const loader = version.loaders?.[0];

        if (mcVersion && loader) {
          try {
            progressTracker.updateStage(
              serverId,
              projectId,
              "downloading",
              "Installing server JAR..."
            );
            const serverJarInfo = await this.backendLogic.getServerJarInfo(
              mcVersion,
              loader
            );
            if (serverJarInfo) {
              const serverJarBuffer = await this.backendLogic.downloadServerJar(
                serverJarInfo
              );
              await this.backendLogic.uploadFileToServer(
                server,
                "/",
                "server.jar",
                serverJarBuffer
              );
            }
          } catch (error: any) {
            this.logger?.error("Server JAR install failed:", error.message);
            progressTracker.addWarning(
              serverId,
              projectId,
              `Server JAR install failed: ${error.message}`
            );
          }
        }
      }

      const fileBuffer = await this.backendLogic.downloadAndCacheFile(
        primaryFile.url,
        primaryFile.filename,
        undefined,
        getCachedData,
        setCachedData
      );

      progressTracker.updateStage(
        serverId,
        projectId,
        "processing",
        `Processing ${primaryFile.filename}...`
      );
      await this.updateInstallationStatus(serverId, versionId, "installing");

      // Install based on file type
      if (primaryFile.filename.endsWith(".mrpack")) {
        await this.installMrpack(
          server,
          fileBuffer,
          getCachedData,
          setCachedData,
          serverId,
          projectId,
          project.title
        );
      } else if (
        this.isModpack(project.project_type, primaryFile.filename) &&
        primaryFile.filename.endsWith(".zip")
      ) {
        await this.installZipFile(
          server,
          fileBuffer,
          serverId,
          projectId,
          project.title
        );
      } else {
        const destination = this.getFileDestination(
          primaryFile.filename,
          project.project_type
        );
        await this.installSingleFile(
          server,
          primaryFile.filename,
          fileBuffer,
          destination,
          project.project_type,
          serverId,
          projectId
        );
      }

      // Complete installation
      progressTracker.completeInstallation(serverId, projectId);
      await this.updateInstallationStatus(serverId, versionId, "completed");

      try {
        await this.prisma.$executeRaw`
          UPDATE ModrinthInstallations 
          SET status = 'completed', installedAt = datetime('now')
          WHERE serverId = ${serverId} AND versionId = ${versionId}
        `;
      } catch {
        try {
          await this.prisma.$executeRaw`
            UPDATE ModrinthInstallation 
            SET status = 'completed', installedAt = datetime('now')
            WHERE serverId = ${serverId} AND versionId = ${versionId}
          `;
        } catch {}
      }

      await this.backendLogic.createDirectory(server, "airlink");
      await this.backendLogic.uploadFileToServer(
        server,
        "airlink",
        "installed.txt",
        Buffer.from("Installed: true")
      );
    } catch (error: any) {
      this.logger?.error("Modpack installation failed:", {
        projectId,
        serverId,
        error: error.message,
        stack: error.stack,
      });

      // error tracking
      progressTracker.failInstallation(
        serverId,
        projectId,
        error.message,
        error.stack
      );

      if (installationCreated) {
        await this.updateInstallationStatus(
          serverId,
          versionId,
          "failed",
          error.message
        );
      }

      throw error;
    }
  }

  private async createDirectoryIfNeeded(
    server: any,
    destinationDir: string
  ): Promise<void> {
    if (destinationDir === "/") return;

    const dirHandlers: Record<string, () => Promise<void>> = {
      mods: () => this.backendLogic.createModsDirectory(server),
      "world/datapacks": async () => {
        await this.backendLogic.createDirectory(server, "world");
        await this.backendLogic.createDirectory(server, "world/datapacks");
      },
    };

    const handler =
      dirHandlers[destinationDir] ||
      (() => this.backendLogic.createDirectory(server, destinationDir));

    try {
      await handler();
    } catch (error: any) {
      // Silent fail but log
      this.logger?.warn(`Failed to create directory ${destinationDir}:`, error.message);
    }
  }

  private async installSingleFile(
    server: any,
    filename: string,
    fileBuffer: Buffer,
    destinationDir: string = "/",
    projectType: string = "",
    serverId?: string,
    projectId?: string
  ): Promise<void> {
    await this.createDirectoryIfNeeded(server, destinationDir);

    if (!Buffer.isBuffer(fileBuffer) || !fileBuffer.length) {
      const error = `Invalid buffer for: ${filename}`;
      if (serverId && projectId) {
        progressTracker.addCriticalError(serverId, projectId, error);
      }
      throw new Error(error);
    }

    const success = await this.backendLogic.uploadFileToServer(
      server,
      destinationDir,
      filename,
      fileBuffer
    );
    
    if (!success) {
      const error = `Upload failed: ${filename}`;
      if (serverId && projectId) {
        progressTracker.addCriticalError(serverId, projectId, error);
      }
      throw new Error(error);
    }
  }

  async installMrpack(
    server: any,
    mrpackBuffer: Buffer,
    getCachedData?: (key: string) => Promise<any>,
    setCachedData?: (
      key: string,
      data: any,
      duration?: number
    ) => Promise<void>,
    serverId?: string,
    projectId?: string,
    projectName?: string
  ): Promise<void> {
    const actualServerId = serverId || server.UUID;
    const actualProjectId = projectId || "mrpack-upload";
    const actualProjectName = projectName || "Uploaded Modpack";

    let zip: AdmZip;
    try {
      zip = new AdmZip(mrpackBuffer);
    } catch (error: any) {
      this.logger?.error("Invalid .mrpack file:", error.message);
      progressTracker.addCriticalError(
        actualServerId,
        actualProjectId,
        `Invalid .mrpack file: ${error.message}`
      );
      throw new Error(`Invalid .mrpack file: ${error.message}`);
    }

    const indexEntry = zip.getEntry("modrinth.index.json");
    if (!indexEntry) {
      const error = "Missing modrinth.index.json in .mrpack file";
      progressTracker.addCriticalError(actualServerId, actualProjectId, error);
      throw new Error(error);
    }

    const indexBuffer = indexEntry.getData();
    if (!indexBuffer?.length) {
      const error = "Empty modrinth.index.json";
      progressTracker.addCriticalError(actualServerId, actualProjectId, error);
      throw new Error(error);
    }

    const index = this.parseMrpackIndex(indexBuffer);

    const loader =
      Object.keys(index.dependencies).find(
        (key) =>
          key !== "minecraft" &&
          ["forge", "fabric", "quilt", "neoforge"].includes(key.toLowerCase())
      ) || "vanilla";

    const overridesEntries = zip
      .getEntries()
      .filter(
        (entry) =>
          entry.entryName.startsWith("overrides/") && !entry.isDirectory
      );

    progressTracker.initializeInstallation(
      actualServerId,
      actualProjectId,
      actualProjectName,
      "modpack",
      index.files.length,
      overridesEntries.length
    );

    progressTracker.updateStage(
      actualServerId,
      actualProjectId,
      "processing",
      "Cleaning up existing mods..."
    );

    try {
      await this.backendLogic.cleanupServerDirectory(server, "/mods");
    } catch (error: any) {
      progressTracker.addWarning(
        actualServerId,
        actualProjectId,
        `Cleanup failed: ${error.message}`
      );
    }

    progressTracker.updateStage(
      actualServerId,
      actualProjectId,
      "installing_overrides",
      `Installing ${overridesEntries.length} override files...`
    );

    let completedOverrides = 0;
    for (const entry of overridesEntries) {
      try {
        const relativePath = entry.entryName.replace("overrides/", "");
        const sanitizedPath = this.backendLogic.sanitizeFilePath(relativePath);

        if (!sanitizedPath) continue;

        const entryBuffer = entry.getData();
        if (!entryBuffer?.length || !Buffer.isBuffer(entryBuffer)) continue;

        const overrideDir = path.dirname(sanitizedPath);
        if (overrideDir && overrideDir !== ".") {
          await this.createDirectoryIfNeeded(server, overrideDir);
        }

        await this.backendLogic.uploadFileToServer(
          server,
          path.dirname(sanitizedPath) || "/",
          path.basename(sanitizedPath),
          entryBuffer
        );

        completedOverrides++;
        progressTracker.updateOverrideProgress(
          actualServerId,
          actualProjectId,
          completedOverrides
        );
      } catch (error: any) {
        progressTracker.addWarning(
          actualServerId,
          actualProjectId,
          `Override error ${entry.entryName}: ${error.message}`
        );
      }
    }

    await this.createDirectoryIfNeeded(server, "mods");

    for (const fileInfo of index.files) {
      const modName = path.basename(fileInfo.path);
      progressTracker.registerMod(
        actualServerId,
        actualProjectId,
        modName,
        fileInfo.fileSize
      );
    }

    progressTracker.updateStage(
      actualServerId,
      actualProjectId,
      "installing_mods",
      `Installing ${index.files.length} mods...`
    );

    const batchSize = this.config.MAX_CONCURRENT_DOWNLOADS || 3;
    for (let i = 0; i < index.files.length; i += batchSize) {
      const batch = index.files.slice(i, i + batchSize);

      const batchPromises = batch.map(async (fileInfo) => {
        const modName = path.basename(fileInfo.path);

        try {
          const skipCheck = this.shouldSkipFile(fileInfo);
          if (skipCheck.skip) {
            progressTracker.updateModProgress(
              actualServerId,
              actualProjectId,
              modName,
              "skipped",
              {
                skipReason: skipCheck.reason,
              }
            );
            return { status: "skipped" };
          }

          if (!fileInfo.path || !fileInfo.downloads?.length) {
            progressTracker.updateModProgress(
              actualServerId,
              actualProjectId,
              modName,
              "failed",
              {
                error: "Invalid file info",
              }
            );
            return { status: "failed" };
          }

          const modBuffer = await this.downloadModpackFile(
            fileInfo,
            actualServerId,
            actualProjectId,
            getCachedData,
            setCachedData
          );

          if (!Buffer.isBuffer(modBuffer) || !modBuffer.length) {
            throw new Error("Invalid mod buffer");
          }

          if (
            fileInfo.fileSize &&
            Math.abs(modBuffer.length - fileInfo.fileSize) > 1024
          ) {
            progressTracker.addWarning(
              actualServerId,
              actualProjectId,
              `Size mismatch ${modName}: expected ${fileInfo.fileSize}, got ${modBuffer.length}`
            );
          }

          const destination = this.getFileDestination(modName, "mod", fileInfo);
          const finalPath = fileInfo.path.includes("/")
            ? fileInfo.path
            : `${destination}/${modName}`;
          const sanitizedPath = this.backendLogic.sanitizeFilePath(finalPath);

          if (!sanitizedPath) throw new Error("Invalid sanitized path");

          const success = await this.backendLogic.uploadFileToServer(
            server,
            path.dirname(sanitizedPath) || "/mods",
            path.basename(sanitizedPath),
            modBuffer
          );

          if (!success) {
            throw new Error("Upload failed");
          }

          return { status: "success" };
        } catch (error: any) {
          progressTracker.updateModProgress(
            actualServerId,
            actualProjectId,
            modName,
            "failed",
            {
              error: error.message,
            }
          );
          return { status: "failed" };
        }
      });

      await Promise.allSettled(batchPromises);

      if (i + batchSize < index.files.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    progressTracker.updateStage(
      actualServerId,
      actualProjectId,
      "finalizing",
      "Finalizing installation..."
    );

    const progress = progressTracker.getProgress(
      actualServerId,
      actualProjectId
    );
    if (
      progress &&
      progress.completedMods === 0 &&
      progress.failedMods === progress.totalMods
    ) {
      const error = "No mod files were successfully processed";
      progressTracker.addCriticalError(actualServerId, actualProjectId, error);
      throw new Error(error);
    }
  }

  async installZipFile(
    server: any,
    zipBuffer: Buffer,
    serverId?: string,
    projectId?: string,
    projectName?: string
  ): Promise<void> {
    const actualServerId = serverId || server.UUID;
    const actualProjectId = projectId || "zip-upload";
    const actualProjectName = projectName || "Uploaded ZIP";

    let zip: AdmZip;
    try {
      zip = new AdmZip(zipBuffer);
    } catch (error: any) {
      this.logger?.error("Invalid ZIP file:", error.message);
      progressTracker.addCriticalError(
        actualServerId,
        actualProjectId,
        `Invalid ZIP file: ${error.message}`
      );
      throw new Error(`Invalid ZIP file: ${error.message}`);
    }

    const entries = zip.getEntries();

    progressTracker.initializeInstallation(
      actualServerId,
      actualProjectId,
      actualProjectName,
      "modpack",
      0,
      entries.length
    );

    progressTracker.updateStage(
      actualServerId,
      actualProjectId,
      "processing",
      `Processing ${entries.length} files from ZIP...`
    );

    try {
      await this.backendLogic.cleanupServerDirectory(server, "/mods");
    } catch (error: any) {
      progressTracker.addWarning(
        actualServerId,
        actualProjectId,
        `Cleanup failed: ${error.message}`
      );
    }

    let completedCount = 0;

    for (const entry of entries) {
      if (entry.isDirectory) continue;

      try {
        const entryBuffer = entry.getData();

        if (!entryBuffer?.length) {
          progressTracker.addWarning(
            actualServerId,
            actualProjectId,
            `Empty file: ${entry.entryName}`
          );
          continue;
        }

        const sanitizedPath = this.backendLogic.sanitizeFilePath(
          entry.entryName
        );
        if (!sanitizedPath) {
          progressTracker.addWarning(
            actualServerId,
            actualProjectId,
            `Invalid path: ${entry.entryName}`
          );
          continue;
        }

        const entryDir = path.dirname(sanitizedPath);
        if (entryDir && entryDir !== "." && entryDir !== "/") {
          await this.createDirectoryIfNeeded(server, entryDir);
        }

        const success = await this.backendLogic.uploadFileToServer(
          server,
          path.dirname(sanitizedPath) || "/",
          path.basename(sanitizedPath),
          entryBuffer
        );

        if (success) {
          completedCount++;
          progressTracker.updateOverrideProgress(
            actualServerId,
            actualProjectId,
            completedCount
          );
        }
      } catch (error: any) {
        progressTracker.addWarning(
          actualServerId,
          actualProjectId,
          `File error ${entry.entryName}: ${error.message}`
        );
      }
    }

    progressTracker.updateStage(
      actualServerId,
      actualProjectId,
      "finalizing",
      "Finalizing installation..."
    );
  }
}