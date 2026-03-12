import { Router } from 'express';
import 'express-session';
import type { PrismaClient as _PrismaClient } from '@prisma/client';
import { google } from 'googleapis';

export type PrismaClient = _PrismaClient;
export type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

declare module 'express-session' {
  interface SessionData {
    user?: {
      id: number | string;
      username?: string;
      email?: string;
      isAdmin?: boolean;
    };
  }
}

export interface AddonAPI {
  registerRoute: (path: string, router: Router) => void;
  logger: Logger;
  prisma: PrismaClient;
  addonPath: string;
  viewsPath: string;
  desktopViewsPath: string;
  mobileViewsPath: string;
  getComponentPath: (componentPath: string) => string;
  utils: {
    isUserAdmin: (userId: number | string) => Promise<boolean>;
    checkServerAccess: (userId: number | string, serverId: number | string) => Promise<boolean>;
    getServerById: (serverId: number | string) => Promise<Server | null>;
    getServerByUUID: (uuid: string) => Promise<Server | null>;
    getServerPorts: (server: Server) => Port[];
    getPrimaryPort: (server: Server) => Port | null;
  };
  ui?: UIManager;
}

export interface Logger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
}

export interface UIManager {
  addSidebarItem?: (item: SidebarItem) => void;
  removeSidebarItem?: (id: string) => void;
  getSidebarItems?: (section?: string) => SidebarItem[];
  addServerMenuItem?: (item: ServerMenuItem) => void;
  removeServerMenuItem?: (id: string) => void;
  getServerMenuItems?: (feature?: string) => ServerMenuItem[];
}

export interface SidebarItem {
  id: string;
  label: string;
  icon?: string;
  url: string;
  section?: 'main' | 'system' | 'other';
  order?: number;
  isAdminItem?: boolean;
}

export interface ServerMenuItem {
  id: string;
  label: string;
  icon?: string;
  url: string;
  feature?: string;
  order?: number;
}

export interface Server {
  UUID: string;
  name?: string;
  description?: string;
  status?: string;
  ownerId?: number;
  nodeId?: number;
  Installing?: boolean;
  Suspended?: boolean;
  node?: Node;
}

export interface Node {
  id: number;
  name?: string;
  address?: string;
  port?: number;
  key?: string;
}

export interface Port {
  port: number;
  protocol?: string;
  primary?: boolean;
}

export interface ParachuteBackup {
  id: number;
  userId: number;
  driveFileId: string;
  backupName: string;
  serverUUID: string;
  encrypted: number;
  passwordHint: string | null;
  fileSize: number | null;
  createdAt: Date;
}

export interface AuthStatus {
  connected: boolean;
  email?: string;
  displayName?: string;
  pictureUrl?: string;
  folderName?: string;
}

export interface BackupResult {
  success: boolean;
  data?: ParachuteBackup;
  error?: string;
}

export interface RestoreResult {
  success: boolean;
  error?: string;
}

export interface DriveTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
}

const progressMap = new Map<string, number>();

export function sendProgress(userId: string | number, step: number): void {
  progressMap.set(userId.toString(), step);
}

export function getProgress(userId: string | number): number {
  return progressMap.get(userId.toString()) ?? 0;
}

export function clearProgress(userId: string | number): void {
  progressMap.delete(userId.toString());
}
