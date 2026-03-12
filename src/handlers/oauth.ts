import { Request, Response } from 'express';
import { google } from 'googleapis';
import crypto from 'crypto';
import { PrismaClient, Logger, DriveTokens, AuthStatus, OAuth2Client } from '../types';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_URL, PARACHUTE_COOKIE_SECRET } from './config';

const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/drive.file',
];

function getOAuthClient(): OAuth2Client {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !APP_URL) {
    throw new Error('Missing OAuth2 configuration in environment variables');
  }
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    `${APP_URL}/parachute/oauth/google/callback`
  );
}

function encryptTokens(tokens: DriveTokens): string {
  const key = crypto.scryptSync(PARACHUTE_COOKIE_SECRET, 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = cipher.update(JSON.stringify(tokens), 'utf8', 'hex') + cipher.final('hex');
  return JSON.stringify({ iv: iv.toString('hex'), encrypted, authTag: cipher.getAuthTag().toString('hex') });
}

function decryptTokens(tokenRef: string): DriveTokens {
  const key = crypto.scryptSync(PARACHUTE_COOKIE_SECRET, 'salt', 32);
  const { iv, encrypted, authTag } = JSON.parse(tokenRef);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  return JSON.parse(decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8'));
}

function createStateToken(userId: number | string): string {
  const payload = JSON.stringify({ userId, timestamp: Date.now() });
  const signature = crypto.createHmac('sha256', PARACHUTE_COOKIE_SECRET).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ payload, signature })).toString('base64');
}

function verifyStateToken(state: string): number | null {
  try {
    const { payload, signature } = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
    const expected = crypto.createHmac('sha256', PARACHUTE_COOKIE_SECRET).update(payload).digest('hex');
    if (signature !== expected) return null;
    const data = JSON.parse(payload);
    if (Date.now() - data.timestamp > 15 * 60 * 1000) return null;
    return Number(data.userId);
  } catch {
    return null;
  }
}

export function handleOAuthConnect(req: Request, res: Response, logger: Logger): void {
  try {
    const client = getOAuthClient();
    const state = createStateToken(req.session.user!.id);
    const authUrl = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent', state });
    logger.info(`OAuth flow started for user ${req.session.user!.id}`);
    res.redirect(authUrl);
  } catch (err) {
    logger.error('OAuth connect error:', err);
    res.redirect('/parachute?error=oauth_init_failed');
  }
}

export async function handleOAuthCallback(req: Request, res: Response, prisma: PrismaClient, logger: Logger): Promise<void> {
  try {
    const code = req.query.code as string;
    const state = req.query.state as string;

    if (!code) { res.redirect('/parachute?error=no_code'); return; }
    if (!state) { res.redirect('/parachute?error=invalid_state'); return; }

    const userId = verifyStateToken(state);
    if (!userId) { res.redirect('/parachute?error=invalid_state'); return; }

    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data: userInfo } = await oauth2.userinfo.get();

    const drive = google.drive({ version: 'v3', auth: client });
    const folderName = `parachute_chute_${userId}`;

    const folderSearch = await drive.files.list({
      q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)',
      spaces: 'drive',
    });

    let folderId: string;
    if (folderSearch.data.files?.length) {
      folderId = folderSearch.data.files[0].id!;
    } else {
      const folder = await drive.files.create({
        requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id',
      });
      folderId = folder.data.id!;
    }

    const tokenRef = encryptTokens(tokens as DriveTokens);
    const { name: displayName = '', email = '', picture: pictureUrl = '' } = userInfo;

    await prisma.$executeRaw`
      INSERT INTO Parachute_Auth (userId, driveFolderId, tokenRef, displayName, email, pictureUrl)
      VALUES (${userId}, ${folderId}, ${tokenRef}, ${displayName}, ${email}, ${pictureUrl})
      ON CONFLICT(userId) DO UPDATE SET
        driveFolderId = ${folderId}, tokenRef = ${tokenRef},
        displayName = ${displayName}, email = ${email}, pictureUrl = ${pictureUrl}
    `;

    const user = await prisma.users.findUnique({ where: { id: Number(userId) } });
    if (!user) { res.redirect('/parachute?error=user_not_found'); return; }

    req.session.user = { id: user.id, username: user.username, email: user.email ?? undefined, isAdmin: user.isAdmin };

    req.session.save((err) => {
      if (err) { logger.error('Session save error:', err); res.redirect('/parachute?error=session_failed'); return; }
      logger.info(`OAuth completed for user ${userId}`);
      res.redirect('/parachute?success=connected');
    });
  } catch (err) {
    logger.error('OAuth callback error:', err);
    res.redirect('/parachute?error=oauth_failed');
  }
}

export async function getAuthStatus(userId: number | string, prisma: PrismaClient, logger: Logger): Promise<AuthStatus> {
  try {
    const rows: unknown[] = await prisma.$queryRaw`
      SELECT displayName, email, pictureUrl FROM Parachute_Auth WHERE userId = ${userId}
    `;
    if (!rows.length) return { connected: false };
    const row = rows[0] as { displayName: string; email: string; pictureUrl: string };
    return {
      connected: true,
      email: row.email,
      displayName: row.displayName,
      pictureUrl: row.pictureUrl,
      folderName: `parachute_chute_${userId}`,
    };
  } catch (err) {
    logger.error('Auth status error:', err);
    return { connected: false };
  }
}

export async function disconnectGoogle(userId: number | string, prisma: PrismaClient, logger: Logger): Promise<void> {
  await prisma.$executeRaw`DELETE FROM Parachute_Auth WHERE userId = ${userId}`;
  logger.info(`User ${userId} disconnected from Google Drive`);
}

export async function getAuthenticatedClient(userId: number | string, prisma: PrismaClient, logger: Logger): Promise<OAuth2Client | null> {
  try {
    const rows: unknown[] = await prisma.$queryRaw`SELECT tokenRef FROM Parachute_Auth WHERE userId = ${userId}`;
    if (!rows.length) return null;
    const tokens = decryptTokens((rows[0] as { tokenRef: string }).tokenRef);
    const client = getOAuthClient();
    client.setCredentials(tokens);
    return client;
  } catch (err) {
    logger.error('Get authenticated client error:', err);
    return null;
  }
}

export async function getDriveFolderId(userId: number | string, prisma: PrismaClient): Promise<string | null> {
  try {
    const rows: unknown[] = await prisma.$queryRaw`SELECT driveFolderId FROM Parachute_Auth WHERE userId = ${userId}`;
    return rows.length ? (rows[0] as { driveFolderId: string }).driveFolderId : null;
  } catch {
    return null;
  }
}
