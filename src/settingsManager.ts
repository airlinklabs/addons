import crypto from 'crypto';
import type { PrismaClient } from './types';

export interface StorageProvider {
  type: 'google_drive' | 'webdav' | 'dropbox' | 's3' | 'ftp';
  enabled: boolean;
}

export interface GoogleDriveConfig extends StorageProvider {
  type: 'google_drive';
  clientId: string;
  clientSecret: string;
}

export interface WebDAVConfig extends StorageProvider {
  type: 'webdav';
  url: string;
  username: string;
  password: string;
  basePath: string;
}

export interface DropboxConfig extends StorageProvider {
  type: 'dropbox';
  appKey: string;
  appSecret: string;
}

export interface S3Config extends StorageProvider {
  type: 's3';
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  endpoint: string;
}

export interface FTPConfig extends StorageProvider {
  type: 'ftp';
  host: string;
  port: number;
  username: string;
  password: string;
  basePath: string;
  secure: boolean;
}

export type ProviderConfig = GoogleDriveConfig | WebDAVConfig | DropboxConfig | S3Config | FTPConfig;

export interface ParachuteSettings {
  appUrl: string;
  cookieSecret: string;
  providers: {
    google_drive: GoogleDriveConfig;
    webdav: WebDAVConfig;
    dropbox: DropboxConfig;
    s3: S3Config;
    ftp: FTPConfig;
  };
}

function defaultSettings(): ParachuteSettings {
  return {
    appUrl: '',
    cookieSecret: crypto.randomBytes(32).toString('hex'),
    providers: {
      google_drive: { type: 'google_drive', enabled: false, clientId: '', clientSecret: '' },
      webdav: { type: 'webdav', enabled: false, url: '', username: '', password: '', basePath: '/parachute' },
      dropbox: { type: 'dropbox', enabled: false, appKey: '', appSecret: '' },
      s3: { type: 's3', enabled: false, accessKeyId: '', secretAccessKey: '', bucket: '', region: 'us-east-1', endpoint: '' },
      ftp: { type: 'ftp', enabled: false, host: '', port: 21, username: '', password: '', basePath: '/parachute', secure: false },
    },
  };
}

type ConfigRow = { key: string; value: string };

export class SettingsManager {
  private prisma: PrismaClient;
  private cached: ParachuteSettings | null = null;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async loadAsync(): Promise<ParachuteSettings> {
    const rows = await this.prisma.$queryRaw<ConfigRow[]>`
      SELECT key, value FROM Parachute_Config
    `;

    if (!rows.length) {
      this.cached = defaultSettings();
      return this.cached;
    }

    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.key] = row.value;
    }

    const defaults = defaultSettings();
    const settings: ParachuteSettings = {
      appUrl: map['appUrl'] ?? defaults.appUrl,
      cookieSecret: map['cookieSecret'] ?? defaults.cookieSecret,
      providers: {
        google_drive: map['providers.google_drive']
          ? { ...defaults.providers.google_drive, ...JSON.parse(map['providers.google_drive']) }
          : defaults.providers.google_drive,
        webdav: map['providers.webdav']
          ? { ...defaults.providers.webdav, ...JSON.parse(map['providers.webdav']) }
          : defaults.providers.webdav,
        dropbox: map['providers.dropbox']
          ? { ...defaults.providers.dropbox, ...JSON.parse(map['providers.dropbox']) }
          : defaults.providers.dropbox,
        s3: map['providers.s3']
          ? { ...defaults.providers.s3, ...JSON.parse(map['providers.s3']) }
          : defaults.providers.s3,
        ftp: map['providers.ftp']
          ? { ...defaults.providers.ftp, ...JSON.parse(map['providers.ftp']) }
          : defaults.providers.ftp,
      },
    };

    this.cached = settings;
    return settings;
  }

  load(): ParachuteSettings {
    if (!this.cached) {
      return defaultSettings();
    }
    return this.cached;
  }

  async save(settings: ParachuteSettings): Promise<void> {
    const entries: Array<[string, string]> = [
      ['appUrl', settings.appUrl],
      ['cookieSecret', settings.cookieSecret],
      ['providers.google_drive', JSON.stringify(settings.providers.google_drive)],
      ['providers.webdav', JSON.stringify(settings.providers.webdav)],
      ['providers.dropbox', JSON.stringify(settings.providers.dropbox)],
      ['providers.s3', JSON.stringify(settings.providers.s3)],
      ['providers.ftp', JSON.stringify(settings.providers.ftp)],
    ];

    for (const [key, value] of entries) {
      await this.prisma.$executeRaw`
        INSERT INTO Parachute_Config (key, value)
        VALUES (${key}, ${value})
        ON CONFLICT(key) DO UPDATE SET value = ${value}, updatedAt = CURRENT_TIMESTAMP
      `;
    }

    this.cached = settings;
  }

  async init(): Promise<void> {
    await this.loadAsync();

    if (!this.cached || !this.cached.cookieSecret) {
      await this.save(defaultSettings());
    }
  }
}

let instance: SettingsManager | null = null;

export async function initSettings(prisma: PrismaClient): Promise<SettingsManager> {
  instance = new SettingsManager(prisma);
  await instance.init();
  return instance;
}

export function getSettings(): SettingsManager {
  if (!instance) throw new Error('SettingsManager not initialized');
  return instance;
}
