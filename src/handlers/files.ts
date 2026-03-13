import { google } from 'googleapis';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import * as tar from 'tar';
import archiver from 'archiver';
import FormData from 'form-data';
import { PrismaClient, Logger, BackupResult, RestoreResult, ParachuteBackup, sendProgress, clearProgress } from '../types';
import { getAuthenticatedClient, getDriveFolderId } from './oauth';
import { SettingsManager } from '../settingsManager';

async function checkServerAccess(userId: number | string, serverUUID: string, prisma: PrismaClient): Promise<boolean> {
  try {
    const [server, user] = await Promise.all([
      prisma.server.findUnique({ where: { UUID: serverUUID }, select: { ownerId: true } }),
      prisma.users.findUnique({ where: { id: Number(userId) }, select: { isAdmin: true } }),
    ]);
    if (!server || !user) return false;
    return user.isAdmin || server.ownerId === Number(userId);
  } catch {
    return false;
  }
}

async function createBackupOnDaemon(server: DaemonServer, backupName: string, logger: Logger): Promise<DaemonBackupResult> {
  try {
    const response = await axios.post(
      `http://${server.node.address}:${server.node.port}/container/backup`,
      { id: server.UUID, name: backupName },
      { auth: { username: 'Airlink', password: server.node.key }, timeout: 1800000 }
    );

    if (response.status === 200 && response.data?.success && response.data?.backup) {
      logger.info(`Daemon backup created: ${response.data.backup.filePath}`);
      return { success: true, backup: response.data.backup };
    }
    return { success: false, error: 'Daemon did not return a successful response' };
  } catch (err: unknown) {
    const error = err as { code?: string; message?: string };
    if (error.code === 'ECONNABORTED') return { success: false, error: 'Backup timed out after 30 minutes' };
    logger.error('Daemon backup error:', error.message);
    return { success: false, error: error.message ?? 'Unknown error' };
  }
}

async function downloadFromDaemon(server: DaemonServer, remotePath: string, localPath: string, logger: Logger): Promise<boolean> {
  try {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    const response = await axios.get(
      `http://${server.node.address}:${server.node.port}/container/backup/download`,
      {
        auth: { username: 'Airlink', password: server.node.key },
        params: { backupPath: remotePath },
        responseType: 'stream',
        timeout: 900000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    const writer = fs.createWriteStream(localPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(true));
      writer.on('error', (err) => { logger.error('Write error:', err); reject(false); });
    });
  } catch (err: unknown) {
    logger.error('Daemon download error:', (err as { message?: string }).message);
    return false;
  }
}

async function deleteFromDaemon(server: DaemonServer, backupPath: string, logger: Logger): Promise<void> {
  try {
    await axios.delete(
      `http://${server.node.address}:${server.node.port}/container/backup`,
      {
        auth: { username: 'Airlink', password: server.node.key },
        data: { backupPath },
        timeout: 60000,
      }
    );
  } catch (err: unknown) {
    logger.warn('Daemon delete failed (non-fatal):', (err as { message?: string }).message);
  }
}

async function encryptBackup(inputPath: string, outputPath: string, password: string, logger: Logger): Promise<boolean> {
  const tempDir = path.join('/tmp', `extract_${Date.now()}`);
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    await tar.extract({ file: inputPath, cwd: tempDir });

    const key = crypto.scryptSync(password, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('tar', { gzip: true, gzipOptions: { level: 6 } });

    output.write(iv);
    archive.pipe(cipher).pipe(output);
    archive.directory(tempDir, false);
    await archive.finalize();

    return new Promise((resolve, reject) => {
      output.on('finish', () => {
        fs.appendFileSync(outputPath, cipher.getAuthTag());
        logger.info('Backup encrypted');
        resolve(true);
      });
      output.on('error', (err) => { logger.error('Encrypt output error:', err); reject(false); });
      archive.on('error', (err) => { logger.error('Encrypt archive error:', err); reject(false); });
    });
  } catch (err: unknown) {
    logger.error('Encrypt error:', (err as { message?: string }).message);
    return false;
  } finally {
    cleanup(tempDir, logger);
  }
}

async function decryptBackup(inputPath: string, outputPath: string, password: string, logger: Logger): Promise<boolean> {
  try {
    const data = fs.readFileSync(inputPath);
    if (data.length < 32) { logger.error('Encrypted file too small'); return false; }

    const key = crypto.scryptSync(password, 'salt', 32);
    const iv = data.subarray(0, 16);
    const authTag = data.subarray(data.length - 16);
    const encrypted = data.subarray(16, data.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    fs.writeFileSync(outputPath, Buffer.concat([decipher.update(encrypted), decipher.final()]));
    logger.info('Backup decrypted');
    return true;
  } catch (err: unknown) {
    logger.error('Decrypt error:', (err as { message?: string }).message);
    return false;
  }
}

async function uploadToDrive(filePath: string, fileName: string, folderId: string, client: unknown, logger: Logger): Promise<{ success: boolean; fileId?: string; error?: string }> {
  try {
    const drive = google.drive({ version: 'v3', auth: client as Parameters<typeof google.drive>[0]['auth'] });
    const file = await drive.files.create({
      requestBody: { name: fileName, parents: [folderId] },
      media: { mimeType: 'application/gzip', body: fs.createReadStream(filePath) },
      fields: 'id',
    });
    logger.info(`Drive upload complete: ${file.data.id}`);
    return { success: true, fileId: file.data.id! };
  } catch (err: unknown) {
    logger.error('Drive upload error:', (err as { message?: string }).message);
    return { success: false, error: (err as { message?: string }).message };
  }
}

async function downloadFromDrive(fileId: string, outputPath: string, client: unknown, logger: Logger): Promise<boolean> {
  try {
    const drive = google.drive({ version: 'v3', auth: client as Parameters<typeof google.drive>[0]['auth'] });
    const dest = fs.createWriteStream(outputPath);
    const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

    return new Promise((resolve, reject) => {
      response.data
        .on('end', () => { logger.info(`Drive download complete: ${fileId}`); resolve(true); })
        .on('error', (err: Error) => { logger.error('Drive download error:', err); reject(false); })
        .pipe(dest);
    });
  } catch (err: unknown) {
    logger.error('Drive download error:', (err as { message?: string }).message);
    return false;
  }
}

async function deleteFromDrive(fileId: string, client: unknown, logger: Logger): Promise<boolean> {
  try {
    const drive = google.drive({ version: 'v3', auth: client as Parameters<typeof google.drive>[0]['auth'] });
    await drive.files.delete({ fileId });
    logger.info(`Drive file deleted: ${fileId}`);
    return true;
  } catch (err: unknown) {
    logger.error('Drive delete error:', (err as { message?: string }).message);
    return false;
  }
}

async function uploadBackupToDaemon(server: DaemonServer, localPath: string, remotePath: string, logger: Logger): Promise<boolean> {
  try {
    const form = new FormData();
    form.append('id', server.UUID);
    form.append('backupPath', remotePath);
    form.append('file', fs.createReadStream(localPath));

    const response = await axios.post(
      `http://${server.node.address}:${server.node.port}/container/restore`,
      form,
      {
        auth: { username: 'Airlink', password: server.node.key },
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 600000,
      }
    );
    return response.status === 200 && response.data?.success;
  } catch (err: unknown) {
    logger.error('Daemon restore error:', (err as { message?: string }).message);
    return false;
  }
}

function cleanup(target: string | null, logger: Logger): void {
  if (!target || !fs.existsSync(target)) return;
  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
    } else {
      fs.unlinkSync(target);
    }
    logger.debug(`Cleaned up: ${target}`);
  } catch {
    logger.warn(`Cleanup failed: ${target}`);
  }
}

interface DaemonServer {
  UUID: string;
  node: { address: string; port: number; key: string };
}

interface DaemonBackupResult {
  success: boolean;
  backup?: { filePath: string; size?: number };
  error?: string;
}

export async function listBackups(userId: number | string, prisma: PrismaClient, logger: Logger): Promise<ParachuteBackup[]> {
  try {
    return await prisma.$queryRaw`SELECT * FROM Parachute_Backups WHERE userId = ${userId} ORDER BY createdAt DESC`;
  } catch (err) {
    logger.error('List backups error:', err);
    return [];
  }
}

export async function listUserServers(userId: number | string, prisma: PrismaClient, logger: Logger): Promise<unknown[]> {
  const select = { UUID: true, name: true, description: true, Installing: true, Suspended: true };
  try {
    const user = await prisma.users.findUnique({ where: { id: Number(userId) } });
    if (user?.isAdmin) {
      return prisma.server.findMany({ select, orderBy: { name: 'asc' } });
    }
    return prisma.server.findMany({ where: { ownerId: Number(userId) }, select, orderBy: { name: 'asc' } });
  } catch (err) {
    logger.error('List servers error:', err);
    return [];
  }
}

export async function createBackup(
  userId: number | string,
  serverUUID: string,
  name: string,
  password: string | undefined,
  passwordHint: string | undefined,
  prisma: PrismaClient,
  logger: Logger,
  settingsMgr: SettingsManager
): Promise<BackupResult> {
  let downloadedPath: string | null = null;
  let encryptedPath: string | null = null;

  try {
    const server = await prisma.server.findUnique({
      where: { UUID: serverUUID },
      select: { UUID: true, name: true, Installing: true, Suspended: true, ownerId: true, node: { select: { address: true, port: true, key: true } } },
    });

    if (!server?.node) return { success: false, error: 'Server not found or missing node config' };
    if (!(await checkServerAccess(userId, serverUUID, prisma))) return { success: false, error: 'Access denied' };
    if (server.Suspended) return { success: false, error: 'Server is suspended' };

    const [oauthClient, folderId] = await Promise.all([
      getAuthenticatedClient(userId, prisma, logger, settingsMgr),
      getDriveFolderId(userId, prisma),
    ]);

    if (!oauthClient) return { success: false, error: 'Not connected to Google Drive' };
    if (!folderId) return { success: false, error: 'Drive folder not found' };

    sendProgress(userId, 1);
    const daemonResult = await createBackupOnDaemon(server as DaemonServer, `parachute_${Date.now()}`, logger);
    if (!daemonResult.success || !daemonResult.backup) return { success: false, error: daemonResult.error };

    sendProgress(userId, 2);
    downloadedPath = path.join('/tmp', `parachute_${Date.now()}_${userId}.tar.gz`);
    if (!(await downloadFromDaemon(server as DaemonServer, daemonResult.backup.filePath, downloadedPath, logger))) {
      return { success: false, error: 'Failed to download backup from daemon' };
    }

    let uploadPath = downloadedPath;
    let encrypted = 0;

    if (password) {
      sendProgress(userId, 3);
      encryptedPath = path.join('/tmp', `parachute_${Date.now()}_${userId}_enc.tar.gz`);
      if (!(await encryptBackup(downloadedPath, encryptedPath, password, logger))) {
        return { success: false, error: 'Failed to encrypt backup' };
      }
      uploadPath = encryptedPath;
      encrypted = 1;
    }

    sendProgress(userId, 4);
    const uploadResult = await uploadToDrive(uploadPath, `${name}_${Date.now()}.tar.gz`, folderId, oauthClient, logger);
    if (!uploadResult.success || !uploadResult.fileId) return { success: false, error: uploadResult.error };

    sendProgress(userId, 5);
    await deleteFromDaemon(server as DaemonServer, daemonResult.backup.filePath, logger);

    sendProgress(userId, 6);
    const provider = 'google_drive';
    await prisma.$executeRaw`
      INSERT INTO Parachute_Backups (userId, driveFileId, backupName, serverUUID, encrypted, passwordHint, fileSize, provider)
      VALUES (${userId}, ${uploadResult.fileId}, ${name}, ${serverUUID}, ${encrypted}, ${passwordHint ?? null}, ${daemonResult.backup.size ?? 0}, ${provider})
    `;

    const rows: unknown[] = await prisma.$queryRaw`SELECT * FROM Parachute_Backups WHERE driveFileId = ${uploadResult.fileId}`;
    logger.info(`Backup created: ${name}`);
    return { success: true, data: rows[0] as ParachuteBackup };
  } catch (err: unknown) {
    logger.error('Create backup error:', err);
    return { success: false, error: (err as { message?: string }).message ?? 'Unknown error' };
  } finally {
    cleanup(downloadedPath, logger);
    cleanup(encryptedPath, logger);
    clearProgress(userId);
  }
}

export async function restoreBackup(
  userId: number | string,
  backupId: number,
  serverUUID: string,
  password: string | undefined,
  prisma: PrismaClient,
  logger: Logger,
  settingsMgr: SettingsManager
): Promise<RestoreResult> {
  let downloadPath: string | null = null;
  let decryptedPath: string | null = null;

  try {
    const backups: unknown[] = await prisma.$queryRaw`SELECT * FROM Parachute_Backups WHERE id = ${backupId} AND userId = ${userId}`;
    if (!backups.length) return { success: false, error: 'Backup not found' };
    const backup = backups[0] as ParachuteBackup;

    const server = await prisma.server.findUnique({
      where: { UUID: serverUUID },
      select: { UUID: true, node: { select: { address: true, port: true, key: true } } },
    });

    if (!server?.node) return { success: false, error: 'Server or node not found' };
    if (!(await checkServerAccess(userId, serverUUID, prisma))) return { success: false, error: 'Access denied' };

    const oauthClient = await getAuthenticatedClient(userId, prisma, logger, settingsMgr);
    if (!oauthClient) return { success: false, error: 'Not connected to Google Drive' };

    sendProgress(userId, 7);
    downloadPath = path.join('/tmp', `restore_${Date.now()}_${userId}.tar.gz`);
    if (!(await downloadFromDrive(backup.driveFileId, downloadPath, oauthClient, logger))) {
      return { success: false, error: 'Failed to download from Drive' };
    }

    let restorePath = downloadPath;

    if (backup.encrypted === 1) {
      if (!password) return { success: false, error: 'Password required for encrypted backup' };
      sendProgress(userId, 8);
      decryptedPath = path.join('/tmp', `restore_${Date.now()}_${userId}_dec.tar.gz`);
      if (!(await decryptBackup(downloadPath, decryptedPath, password, logger))) {
        return { success: false, error: 'Failed to decrypt - incorrect password?' };
      }
      restorePath = decryptedPath;
    }

    sendProgress(userId, 9);
    const remotePath = `backups/${server.UUID}/restore_${Date.now()}.tar.gz`;
    if (!(await uploadBackupToDaemon(server as DaemonServer, restorePath, remotePath, logger))) {
      return { success: false, error: 'Failed to restore on daemon' };
    }

    logger.info(`Backup restored: ${backup.backupName}`);
    return { success: true };
  } catch (err: unknown) {
    logger.error('Restore backup error:', err);
    return { success: false, error: (err as { message?: string }).message ?? 'Unknown error' };
  } finally {
    cleanup(downloadPath, logger);
    cleanup(decryptedPath, logger);
    clearProgress(userId);
  }
}

export async function deleteBackup(userId: number | string, backupId: number, prisma: PrismaClient, logger: Logger, settingsMgr: SettingsManager): Promise<{ success: boolean; error?: string }> {
  try {
    const backups: unknown[] = await prisma.$queryRaw`SELECT * FROM Parachute_Backups WHERE id = ${backupId} AND userId = ${userId}`;
    if (!backups.length) return { success: false, error: 'Backup not found' };
    const backup = backups[0] as ParachuteBackup;

    const oauthClient = await getAuthenticatedClient(userId, prisma, logger, settingsMgr);
    if (oauthClient) await deleteFromDrive(backup.driveFileId, oauthClient, logger);

    await prisma.$executeRaw`DELETE FROM Parachute_Backups WHERE id = ${backupId}`;
    logger.info(`Backup deleted: ${backup.backupName}`);
    return { success: true };
  } catch (err: unknown) {
    logger.error('Delete backup error:', err);
    return { success: false, error: (err as { message?: string }).message };
  }
}

export async function renameBackup(userId: number | string, backupId: number, newName: string, prisma: PrismaClient, logger: Logger): Promise<{ success: boolean; error?: string }> {
  try {
    const backups: unknown[] = await prisma.$queryRaw`SELECT id FROM Parachute_Backups WHERE id = ${backupId} AND userId = ${userId}`;
    if (!backups.length) return { success: false, error: 'Backup not found' };

    await prisma.$executeRaw`UPDATE Parachute_Backups SET backupName = ${newName} WHERE id = ${backupId}`;
    logger.info(`Backup renamed: ${backupId} -> ${newName}`);
    return { success: true };
  } catch (err: unknown) {
    logger.error('Rename backup error:', err);
    return { success: false, error: (err as { message?: string }).message };
  }
}
