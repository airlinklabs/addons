/**
 * =============================================================================
 * File: backend-logic.ts
 * Author: g-flame
 * =============================================================================
 */
import axios, { AxiosRequestConfig } from "axios";
import path from "path";
import crypto from "crypto";
import { ServerInfo } from "../types/types";

export class BackendLogic {
  constructor(private logger: any, private config: any) {}

  async getServerStatus(
    serverInfo: ServerInfo
  ): Promise<{ daemonOffline: boolean }> {
    try {
      await axios.get(
        `http://${serverInfo.nodeAddress}:${serverInfo.nodePort}/`,
        {
          auth: { username: "Airlink", password: serverInfo.nodeKey },
          timeout: 5000,
        }
      );
      return { daemonOffline: false };
    } catch {
      return { daemonOffline: true };
    }
  }

  sanitizeFilePath(filePath: string): string {
    if (!filePath?.trim()) return "";

    return path
      .normalize(filePath)
      .replace(/^(\.\.[\/\\])+/, "")
      .replace(/[<>:"|?*]/g, "_")
      .replace(/\.\./g, "")
      .replace(/^\/+(?!\/)/, "");
  }

  private validateServerConfig(server: any): void {
    if (
      !server?.node?.address ||
      !server?.node?.port ||
      !server?.node?.key ||
      !server?.UUID
    ) {
      throw new Error("Invalid server configuration");
    }
  }

  private createRequest(
    server: any,
    method: string,
    endpoint: string,
    data?: any
  ): AxiosRequestConfig {
    return {
      method,
      url: `http://${server.node.address}:${server.node.port}${endpoint}`,
      auth: { username: "Airlink", password: server.node.key },
      headers: { "Content-Type": "application/json" },
      data,
      timeout: 30000,
    };
  }

  async uploadFileToServer(
    server: any,
    relativePath: string,
    fileName: string,
    fileBuffer: Buffer
  ): Promise<boolean> {
    try {
      this.validateServerConfig(server);

      if (!fileBuffer?.length || !fileName?.trim()) {
        throw new Error("Invalid file data");
      }

      const sanitizedPath = this.sanitizeFilePath(relativePath) || "/";
      const sanitizedFileName = this.sanitizeFilePath(fileName);

      if (!sanitizedFileName) throw new Error("Invalid file name");

      const request = this.createRequest(server, "POST", "/fs/upload", {
        id: server.UUID,
        path: sanitizedPath,
        fileName: sanitizedFileName,
        fileContent: `data:application/octet-stream;base64,${fileBuffer.toString(
          "base64"
        )}`,
      });

      request.maxContentLength = this.config.MAX_FILE_SIZE * 2;
      request.maxBodyLength = this.config.MAX_FILE_SIZE * 2;
      request.timeout = this.config.DOWNLOAD_TIMEOUT || 30000;

      const response = await axios(request);
      const success = response.status === 200;

      return success;
    } catch (error: any) {
      
      return false;
    }
  }

  async cleanupServerDirectory(
    server: any,
    directory: string
  ): Promise<boolean> {
    return this.deleteServerFile(server, directory);
  }

  async deleteServerFile(server: any, filePath: string): Promise<boolean> {
    try {
      this.validateServerConfig(server);
      const sanitizedPath = this.sanitizeFilePath(filePath);
      if (!sanitizedPath) return false;

      const response = await axios(
        this.createRequest(server, "DELETE", "/fs/delete", {
          id: server.UUID,
          path: sanitizedPath,
        })
      );

      const success = response.status === 200;
      this.logger?.[success ? "info" : "warn"](
        `Delete ${success ? "success" : "failed"}: ${sanitizedPath}`
      );

      return success;
    } catch (error: any) {
      
      return false;
    }
  }

  async createDirectory(server: any, directoryPath: string): Promise<boolean> {
    try {
      this.validateServerConfig(server);
      const sanitizedPath = this.sanitizeFilePath(directoryPath);
      if (!sanitizedPath) return false;

      const normalizedPath = sanitizedPath.endsWith("/")
        ? sanitizedPath
        : sanitizedPath + "/";

      const response = await axios(
        this.createRequest(server, "POST", "/fs/mkdir", {
          id: server.UUID,
          path: normalizedPath,
        })
      );

      const success = response.status === 200;
      if (success) this.logger?.info(`Created directory: ${normalizedPath}`);

      return success;
    } catch (error: any) {
      if (
        error.response?.status === 409 ||
        error.message?.includes("already exists")
      ) {
        return true;
      }
      
      return false;
    }
  }

  async createModsDirectory(server: any): Promise<void> {
    const success = await this.createDirectory(server, "mods");
    if (!success) this.logger?.warn("Failed to create /mods/ directory");
  }

  private validateHash(buffer: Buffer, expectedHash: string): boolean {
    try {
      const hashType = expectedHash.length === 64 ? "sha256" : "sha1";
      const hash = crypto.createHash(hashType).update(buffer).digest("hex");
      return hash.toLowerCase() === expectedHash.toLowerCase();
    } catch {
      return false;
    }
  }

  async downloadAndCacheFile(
    url: string,
    filename: string,
    expectedHash?: string,
    getCachedData?: (key: string) => Promise<any>,
    setCachedData?: (key: string, data: any, duration?: number) => Promise<void>
  ): Promise<Buffer> {
    if (!url || !filename) throw new Error("URL and filename required");

    const cacheKey = `file:${url}:${expectedHash || "no-hash"}`;

    // Try cache first
    if (getCachedData) {
      try {
        const cached = await getCachedData(cacheKey);
        if (cached?.buffer && cached?.filename === filename) {
          const buffer = Buffer.from(cached.buffer, "base64");
          if (!expectedHash || this.validateHash(buffer, expectedHash)) {
            return buffer;
          }
        }
      } catch (error) {
        this.logger?.warn("Cache read error:", error);
      }
    }

    // Download with retry logic
    const maxAttempts = this.config.RETRY_ATTEMPTS || 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {

        const response = await axios.get(url, {
          responseType: "arraybuffer",
          headers: {
            "User-Agent": this.config.USER_AGENT || "ModrinthInstaller/1.0",
            Accept: "*/*",
            "Accept-Encoding": "gzip, deflate, br",
          },
          timeout: this.config.DOWNLOAD_TIMEOUT || 60000,
          maxContentLength: this.config.MAX_FILE_SIZE || 500 * 1024 * 1024,
          maxBodyLength: this.config.MAX_FILE_SIZE || 500 * 1024 * 1024,
        });

        const buffer = Buffer.from(response.data);
        if (!buffer.length) throw new Error("Empty file");

        // Validate hash
        if (expectedHash && !this.validateHash(buffer, expectedHash)) {
          throw new Error(`Hash validation failed for ${filename}`);
        }

        this.logger?.info(`Downloaded ${filename}: ${buffer.length} bytes`);

        // Cache if small enough
        if (buffer.length < 50 * 1024 * 1024 && setCachedData) {
          try {
            await setCachedData(
              cacheKey,
              {
                buffer: buffer.toString("base64"),
                filename,
                size: buffer.length,
                hash: expectedHash,
                downloadedAt: new Date().toISOString(),
              },
              10 * 60 * 1000
            );
          } catch (cacheError) {
            this.logger?.warn("Cache write error:", cacheError);
          }
        }

        return buffer;
      } catch (error: any) {
        const isLast = attempt >= maxAttempts - 1;
        this.logger?.warn(
          `Download attempt ${attempt + 1} failed: ${error.message}`
        );

        if (isLast)
          throw new Error(
            `Download failed after ${maxAttempts} attempts: ${error.message}`
          );

        const delay = (this.config.RETRY_DELAY || 1000) * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error(`Download failed for ${filename}`);
  }

  async getServerJarInfo(
    minecraftVersion: string,
    loader: string
  ): Promise<{ version: string; url: string; loader: string } | null> {
    try {
      if (!minecraftVersion || !loader) return null;

      const cleanVersion = minecraftVersion.replace(/^mc\.?/, "").trim();
      const loaderLower = loader.toLowerCase();
      let serverJarUrl = "";

      

      const loaderHandlers: Record<string, () => Promise<string>> = {
        forge: async () => {
          const response = await axios.get(
            `https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json`,
            { timeout: 15000 }
          );
          const version =
            response.data.promos[`${cleanVersion}-latest`] ||
            response.data.promos[`${cleanVersion}-recommended`];
          return version
            ? `https://maven.minecraftforge.net/net/minecraftforge/forge/${cleanVersion}-${version}/forge-${cleanVersion}-${version}-installer.jar`
            : "";
        },

        fabric: async () => {
          const [loaderResponse, installerResponse] = await Promise.all([
            axios.get(
              `https://meta.fabricmc.net/v2/versions/loader/${cleanVersion}`,
              { timeout: 15000 }
            ),
            axios.get("https://meta.fabricmc.net/v2/versions/installer", {
              timeout: 15000,
            }),
          ]);

          if (loaderResponse.data?.length && installerResponse.data?.length) {
            const loaderVersion = loaderResponse.data[0].loader.version;
            const installerVersion = installerResponse.data[0].version;
            return `https://meta.fabricmc.net/v2/versions/loader/${cleanVersion}/${loaderVersion}/${installerVersion}/server/jar`;
          }
          return "";
        },

        quilt: async () => {
          const [loaderResponse, installerResponse] = await Promise.all([
            axios.get(
              `https://meta.quiltmc.org/v3/versions/loader/${cleanVersion}`,
              { timeout: 15000 }
            ),
            axios.get("https://meta.quiltmc.org/v3/versions/installer", {
              timeout: 15000,
            }),
          ]);

          if (loaderResponse.data?.length && installerResponse.data?.length) {
            const loaderVersion = loaderResponse.data[0].loader.version;
            const installerVersion = installerResponse.data[0].version;
            return `https://meta.quiltmc.org/v3/versions/loader/${cleanVersion}/${loaderVersion}/${installerVersion}/server/jar`;
          }
          return "";
        },

        neoforge: async () => {
          const response = await axios.get(
            `https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge`,
            { timeout: 15000 }
          );
          const version = response.data.versions
            ?.filter((v: string) => v?.includes(cleanVersion))
            ?.sort((a: string, b: string) => {
              const aExact = a.startsWith(cleanVersion);
              const bExact = b.startsWith(cleanVersion);
              return aExact && !bExact
                ? -1
                : !aExact && bExact
                ? 1
                : b.localeCompare(a);
            })[0];

          return version
            ? `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`
            : "";
        },

        vanilla: async () => {
          const manifest = await axios.get(
            "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
            { timeout: 15000 }
          );
          const versionInfo = manifest.data.versions?.find(
            (v: any) => v?.id === cleanVersion
          );

          if (versionInfo?.url) {
            const details = await axios.get(versionInfo.url, {
              timeout: 15000,
            });
            return details.data.downloads?.server?.url || "";
          }
          return "";
        },
      };

      const handler = loaderHandlers[loaderLower] || loaderHandlers.vanilla;
      serverJarUrl = await handler();

      return serverJarUrl
        ? { version: cleanVersion, url: serverJarUrl, loader }
        : null;
    } catch (error: any) {
      this.logger?.error(
        `Server JAR info error for ${loader} ${minecraftVersion}: ${error.message}`
      );
      return null;
    }
  }

  async downloadServerJar(serverJarInfo: {
    version: string;
    url: string;
    loader: string;
  }): Promise<Buffer> {
    if (!serverJarInfo?.url) throw new Error("Invalid server jar info");

  

    const response = await axios.get(serverJarInfo.url, {
      responseType: "arraybuffer",
      headers: {
        "User-Agent": this.config.USER_AGENT || "ModrinthInstaller/1.0",
      },
      timeout: this.config.DOWNLOAD_TIMEOUT || 120000,
      maxContentLength: this.config.MAX_FILE_SIZE || 500 * 1024 * 1024,
      maxBodyLength: this.config.MAX_FILE_SIZE || 500 * 1024 * 1024,
    });

    const buffer = Buffer.from(response.data);
    if (!buffer.length) throw new Error("Empty server JAR");

    return buffer;
  }

  async checkDirectoryExists(
    server: any,
    directoryPath: string
  ): Promise<boolean> {
    try {
      this.validateServerConfig(server);
      const sanitizedPath = this.sanitizeFilePath(directoryPath);
      if (!sanitizedPath) return false;

      const response = await axios({
        method: "GET",
        url: `http://${server.node.address}:${server.node.port}/fs/list`,
        auth: { username: "Airlink", password: server.node.key },
        params: { id: server.UUID, path: sanitizedPath },
        timeout: 15000,
      });

      return response.status === 200;
    } catch {
      return false;
    }
  }
}
