/**
 * =============================================================================
 * File: progress-tracker.ts (Enhanced)
 * Author: g-flame
 * =============================================================================
 */

export interface ModInstallProgress {
  name: string;
  status: "pending" | "downloading" | "completed" | "failed" | "skipped";
  error?: string;
  size?: number;
  downloadedSize?: number;
  skipReason?: string;
}

export interface InstallationProgress {
  serverId: string;
  projectId: string;
  projectName: string;
  projectType: string;

  // Overall progress
  stage:
    | "initializing"
    | "downloading"
    | "processing"
    | "installing_mods"
    | "installing_overrides"
    | "finalizing"
    | "completed"
    | "failed";
  stageMessage: string;
  overallProgress: number; // 0-100

  // Detailed tracking
  totalMods: number;
  completedMods: number;
  failedMods: number;
  skippedMods: number;

  totalOverrides: number;
  completedOverrides: number;

  // Individual mod tracking
  mods: Map<string, ModInstallProgress>;
  currentMod?: string;

  // Timing
  startTime: number;
  lastUpdate: number;

  // Error tracking
  error?: string;
  errorDetails?: string; // More detailed error information
  warnings: string[];
  criticalErrors: string[]; // NEW: Track critical errors separately
}

class ProgressTracker {
  private installations = new Map<string, InstallationProgress>();
  private readonly MAX_HISTORY = 100;

  /**
   * Initialize a new installation progress tracker
   */
  initializeInstallation(
    serverId: string,
    projectId: string,
    projectName: string,
    projectType: string,
    totalMods: number = 0,
    totalOverrides: number = 0
  ): void {
    const key = `${serverId}-${projectId}`;

    // Clear any existing installation for this server/project
    if (this.installations.has(key)) {
      this.installations.delete(key);
    }

    // Also clear any old completed/failed installations for this server
    for (const [existingKey, progress] of this.installations.entries()) {
      if (
        progress.serverId === serverId &&
        (progress.stage === "completed" || progress.stage === "failed")
      ) {
        this.installations.delete(existingKey);
      }
    }

    this.installations.set(key, {
      serverId,
      projectId,
      projectName,
      projectType,
      stage: "initializing",
      stageMessage: "Preparing installation...",
      overallProgress: 0,
      totalMods,
      completedMods: 0,
      failedMods: 0,
      skippedMods: 0,
      totalOverrides,
      completedOverrides: 0,
      mods: new Map(),
      startTime: Date.now(),
      lastUpdate: Date.now(),
      warnings: [],
      criticalErrors: [], // NEW
    });
  }

  /**
   * Update the current installation stage
   */
  updateStage(
    serverId: string,
    projectId: string,
    stage: InstallationProgress["stage"],
    message: string
  ): void {
    const key = `${serverId}-${projectId}`;
    const progress = this.installations.get(key);

    if (!progress) return;

    progress.stage = stage;
    progress.stageMessage = message;
    progress.lastUpdate = Date.now();

    // Update overall progress based on stage
    const stageProgress: Record<typeof stage, number> = {
      initializing: 5,
      downloading: 15,
      processing: 25,
      installing_mods: 50,
      installing_overrides: 80,
      finalizing: 95,
      completed: 100,
      failed: progress.overallProgress,
    };

    progress.overallProgress = Math.max(
      progress.overallProgress,
      stageProgress[stage]
    );
  }

  /**
   * Register a mod for tracking
   */
  registerMod(
    serverId: string,
    projectId: string,
    modName: string,
    size?: number
  ): void {
    const key = `${serverId}-${projectId}`;
    const progress = this.installations.get(key);

    if (!progress) return;

    progress.mods.set(modName, {
      name: modName,
      status: "pending",
      size,
    });
  }

  /**
   * Update mod download progress
   */
  updateModProgress(
    serverId: string,
    projectId: string,
    modName: string,
    status: ModInstallProgress["status"],
    options?: {
      downloadedSize?: number;
      error?: string;
      skipReason?: string;
    }
  ): void {
    const key = `${serverId}-${projectId}`;
    const progress = this.installations.get(key);

    if (!progress) return;

    let mod = progress.mods.get(modName);
    if (!mod) {
      // Register if not exists
      this.registerMod(serverId, projectId, modName);
      mod = progress.mods.get(modName)!;
    }

    const previousStatus = mod.status;
    mod.status = status;
    mod.downloadedSize = options?.downloadedSize;
    mod.error = options?.error;
    mod.skipReason = options?.skipReason;

    progress.currentMod = status === "downloading" ? modName : undefined;
    progress.lastUpdate = Date.now();

    // Update counters only if status changed
    if (previousStatus !== status) {
      if (status === "completed") {
        progress.completedMods++;
      } else if (status === "failed") {
        progress.failedMods++;
        // NEW: Add to critical errors if it's a critical failure
        if (options?.error) {
          this.addCriticalError(serverId, projectId, `${modName}: ${options.error}`);
        }
      } else if (status === "skipped") {
        progress.skippedMods++;
      }
    }

    // Calculate mod installation progress (25-75% range)
    if (progress.totalMods > 0) {
      const modsProgress =
        (progress.completedMods + progress.skippedMods) / progress.totalMods;
      const calculatedProgress = 25 + modsProgress * 50;
      progress.overallProgress = Math.max(
        progress.overallProgress,
        calculatedProgress
      );
    }
  }

  /**
   * Update override installation progress
   */
  updateOverrideProgress(
    serverId: string,
    projectId: string,
    completed: number
  ): void {
    const key = `${serverId}-${projectId}`;
    const progress = this.installations.get(key);

    if (!progress) return;

    progress.completedOverrides = completed;
    progress.lastUpdate = Date.now();

    // Calculate override progress (75-90%)
    if (progress.totalOverrides > 0) {
      const overridesProgress = completed / progress.totalOverrides;
      const calculatedProgress = 75 + overridesProgress * 15;
      progress.overallProgress = Math.max(
        progress.overallProgress,
        calculatedProgress
      );
    }
  }

  /**
   * Add a warning
   */
  addWarning(serverId: string, projectId: string, warning: string): void {
    const key = `${serverId}-${projectId}`;
    const progress = this.installations.get(key);

    if (!progress) return;

    // Limit warnings to prevent memory issues
    if (progress.warnings.length < 50) {
      progress.warnings.push(warning);
    }
    progress.lastUpdate = Date.now();
  }

  /**
   * Add a critical error - NEW METHOD
   */
  addCriticalError(serverId: string, projectId: string, error: string): void {
    const key = `${serverId}-${projectId}`;
    const progress = this.installations.get(key);

    if (!progress) return;

    // Limit critical errors to prevent memory issues
    if (progress.criticalErrors.length < 20) {
      progress.criticalErrors.push(error);
    }
    progress.lastUpdate = Date.now();
  }

  /**
   * Mark installation as completed
   */
  completeInstallation(serverId: string, projectId: string): void {
    const key = `${serverId}-${projectId}`;
    const progress = this.installations.get(key);

    if (!progress) return;

    progress.stage = "completed";
    progress.stageMessage = "Installation completed successfully";
    progress.overallProgress = 100;
    progress.currentMod = undefined;
    progress.lastUpdate = Date.now();

    // Auto-cleanup after 30 seconds for completed installations
    setTimeout(() => {
      this.installations.delete(key);
    }, 30000);
  }

  /**
   * Mark installation as failed - ENHANCED
   */
  failInstallation(
    serverId: string,
    projectId: string,
    error: string,
    errorDetails?: string
  ): void {
    const key = `${serverId}-${projectId}`;
    const progress = this.installations.get(key);

    if (!progress) return;

    progress.stage = "failed";
    progress.stageMessage = "Installation failed";
    progress.error = error;
    progress.errorDetails = errorDetails; // NEW
    progress.currentMod = undefined;
    progress.lastUpdate = Date.now();

    // Add to critical errors
    this.addCriticalError(serverId, projectId, error);

    // Auto-cleanup after 60 seconds for failed installations
    setTimeout(() => {
      this.installations.delete(key);
    }, 60000);
  }

  /**
   * Get current progress for an installation
   */
  getProgress(
    serverId: string,
    projectId: string
  ): InstallationProgress | null {
    const key = `${serverId}-${projectId}`;
    return this.installations.get(key) || null;
  }

  /**
   * Get all active installations
   */
  getAllProgress(): InstallationProgress[] {
    return Array.from(this.installations.values());
  }

  /**
   * Clear completed/failed installations older than 30 sec
   */
  cleanup(): void {
    const now = Date.now();
    const fiveMinutes = 30 * 1000;

    for (const [key, progress] of this.installations.entries()) {
      // Remove completed/failed older than 30 sec
      if (
        (progress.stage === "completed" || progress.stage === "failed") &&
        now - progress.lastUpdate > fiveMinutes
      ) {
        this.installations.delete(key);
      }

      // Also remove stale in-progress installations older than 30 minutes
      const thirtyMinutes = 30 * 60 * 1000;
      if (
        progress.stage !== "completed" &&
        progress.stage !== "failed" &&
        now - progress.lastUpdate > thirtyMinutes
      ) {
        this.installations.delete(key);
      }
    }

    // Keep only last N installations
    if (this.installations.size > this.MAX_HISTORY) {
      const sorted = Array.from(this.installations.entries()).sort(
        (a, b) => b[1].lastUpdate - a[1].lastUpdate
      );

      this.installations.clear();
      sorted.slice(0, this.MAX_HISTORY).forEach(([k, v]) => {
        this.installations.set(k, v);
      });
    }
  }

  /**
   * Clear specific installation progress
   */
  clearProgress(serverId: string, projectId: string): void {
    const key = `${serverId}-${projectId}`;
    this.installations.delete(key);
  }

  /**
   * Serialize progress for API response 
   */
  serializeProgress(progress: InstallationProgress): any {
    return {
      serverId: progress.serverId,
      projectId: progress.projectId,
      projectName: progress.projectName,
      projectType: progress.projectType,
      stage: progress.stage,
      stageMessage: progress.stageMessage,
      overallProgress: Math.round(progress.overallProgress),
      totalMods: progress.totalMods,
      completedMods: progress.completedMods,
      failedMods: progress.failedMods,
      skippedMods: progress.skippedMods,
      totalOverrides: progress.totalOverrides,
      completedOverrides: progress.completedOverrides,
      currentMod: progress.currentMod,
      mods: Array.from(progress.mods.values()),
      elapsedTime: Date.now() - progress.startTime,
      error: progress.error,
      errorDetails: progress.errorDetails, // NEW
      warnings: progress.warnings,
      criticalErrors: progress.criticalErrors, // NEW
    };
  }
}

// Singleton instance
export const progressTracker = new ProgressTracker();

// Cleanup interval - run every minute
setInterval(() => {
  progressTracker.cleanup();
}, 60 * 1000);

