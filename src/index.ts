import { Router, Request, Response } from 'express';
import path from 'path';
import { AddonAPI, getProgress } from './types';
import { setupUI, isMobile, resolveView, getComponents } from './ui';
import { handleOAuthConnect, handleOAuthCallback, getAuthStatus, disconnectGoogle } from './handlers/oauth';
import { listBackups, createBackup, restoreBackup, deleteBackup, renameBackup, listUserServers } from './handlers/files';
import { initSettings } from './settingsManager';

function requireAuth(req: Request, res: Response): boolean {
  if (!req.session?.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return false;
  }
  return true;
}

function requireAdmin(req: Request, res: Response): boolean {
  if (!req.session?.user?.isAdmin) {
    res.status(403).json({ success: false, error: 'Admin access required' });
    return false;
  }
  return true;
}

export default async function(router: Router, api: AddonAPI): Promise<void> {
  const { logger, prisma } = api;

  const settingsMgr = await initSettings(prisma);
  logger.info('Parachute settings loaded from database');

  setupUI(api);

  router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!req.session?.user) { res.redirect('/login?redirect=/parachute'); return; }

      const [status, settings, dbSettings] = await Promise.all([
        getAuthStatus(req.session.user.id, prisma, logger, settingsMgr),
        settingsMgr.loadAsync(),
        prisma.settings.findUnique({ where: { id: 1 } }),
      ]);

      const mobile = isMobile(req);
      const viewPath = resolveView(api, 'parachute.ejs', mobile);
      const components = getComponents(api, req);
      const viewDir = mobile ? api.mobileViewsPath : api.desktopViewsPath;

      res.render(viewPath, {
        title: 'Parachute',
        user: req.session.user,
        req,
        settings: dbSettings,
        status,
        parachuteSettings: settings,
        components: {
          ...components,
          providerPanel: path.join(viewDir, 'provider-panel.ejs'),
          fileList: path.join(viewDir, 'file.ejs'),
          serverSelector: path.join(viewDir, 'server-selector.ejs'),
          createBackupModal: path.join(viewDir, 'create-backup-modal.ejs'),
          restoreBackupModal: path.join(viewDir, 'restore-backup-modal.ejs'),
          renameBackupModal: path.join(viewDir, 'rename-backup-modal.ejs'),
          deleteConfirmModal: path.join(viewDir, 'delete-confirm-modal.ejs'),
          toast: path.join(api.viewsPath, 'toast.ejs'),
        },
      });
    } catch (err) {
      logger.error('Render error:', err);
      res.status(500).send('Failed to load backup manager');
    }
  });

  router.get('/admin', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!req.session?.user) { res.redirect('/login?redirect=/parachute/admin'); return; }
      if (!req.session.user.isAdmin) { res.redirect('/parachute'); return; }

      const [parachuteSettings, dbSettings] = await Promise.all([
        settingsMgr.loadAsync(),
        prisma.settings.findUnique({ where: { id: 1 } }),
      ]);

      const mobile = isMobile(req);
      const viewPath = resolveView(api, 'admin-config.ejs', mobile);
      const components = getComponents(api, req);

      res.render(viewPath, {
        title: 'Parachute — Admin',
        user: req.session.user,
        req,
        settings: dbSettings,
        parachuteSettings,
        components,
      });
    } catch (err) {
      logger.error('Admin render error:', err);
      res.status(500).send('Failed to load admin config');
    }
  });

  router.get('/api/admin/settings', async (req: Request, res: Response): Promise<void> => {
    if (!requireAuth(req, res)) return;
    if (!requireAdmin(req, res)) return;
    try {
      const settings = await settingsMgr.loadAsync();
      const sanitized = JSON.parse(JSON.stringify(settings));
      for (const key of Object.keys(sanitized.providers) as (keyof typeof sanitized.providers)[]) {
        const p = sanitized.providers[key];
        if ('password' in p && p.password) p.password = '••••••••';
        if ('secretAccessKey' in p && p.secretAccessKey) p.secretAccessKey = '••••••••';
        if ('appSecret' in p && p.appSecret) p.appSecret = '••••••••';
        if ('clientSecret' in p && p.clientSecret) p.clientSecret = '••••••••';
      }
      if (sanitized.cookieSecret) sanitized.cookieSecret = '••••••••';
      res.json({ success: true, data: sanitized });
    } catch (err) {
      logger.error('Admin get settings error:', err);
      res.status(500).json({ success: false, error: 'Failed to load settings' });
    }
  });

  router.post('/api/admin/settings', async (req: Request, res: Response): Promise<void> => {
    if (!requireAuth(req, res)) return;
    if (!requireAdmin(req, res)) return;
    try {
      const current = await settingsMgr.loadAsync();
      const body = req.body;

      if (body.appUrl !== undefined) current.appUrl = body.appUrl;
      if (body.cookieSecret && body.cookieSecret !== '••••••••') current.cookieSecret = body.cookieSecret;

      if (body.providers) {
        const providerMap = current.providers as Record<string, unknown>;
        for (const key of Object.keys(body.providers as Record<string, unknown>)) {
          const incoming = (body.providers as Record<string, unknown>)[key] as Record<string, unknown>;
          const existing = (providerMap[key] ?? {}) as Record<string, unknown>;
          const merged: Record<string, unknown> = { ...existing, ...incoming };
          for (const secretField of ['password', 'secretAccessKey', 'appSecret', 'clientSecret']) {
            if (merged[secretField] === '••••••••') merged[secretField] = existing[secretField] ?? '';
          }
          providerMap[key] = merged;
        }
      }

      await settingsMgr.save(current);
      logger.info(`Admin ${req.session!.user!.id} saved Parachute settings`);
      res.json({ success: true });
    } catch (err) {
      logger.error('Admin save settings error:', err);
      res.status(500).json({ success: false, error: 'Failed to save settings' });
    }
  });

  router.get('/oauth/google/connect', async (req: Request, res: Response) => {
    if (!req.session?.user) { res.redirect('/login?redirect=/parachute'); return; }
    const settings = await settingsMgr.loadAsync();
    handleOAuthConnect(req, res, logger, settings);
  });

  router.get('/oauth/google/callback', (req: Request, res: Response) =>
    handleOAuthCallback(req, res, prisma, logger, settingsMgr)
  );

  router.get('/api/status', async (req: Request, res: Response): Promise<void> => {
    if (!requireAuth(req, res)) return;
    try {
      const status = await getAuthStatus(req.session!.user!.id, prisma, logger, settingsMgr);
      res.json({ success: true, data: status });
    } catch (err) {
      logger.error('Status error:', err);
      res.status(500).json({ success: false, error: 'Failed to fetch status' });
    }
  });

  router.post('/api/disconnect', async (req: Request, res: Response): Promise<void> => {
    if (!requireAuth(req, res)) return;
    try {
      await disconnectGoogle(req.session!.user!.id, prisma, logger);
      res.json({ success: true, message: 'Disconnected from Google Drive' });
    } catch (err) {
      logger.error('Disconnect error:', err);
      res.status(500).json({ success: false, error: 'Failed to disconnect' });
    }
  });

  router.get('/api/backups', async (req: Request, res: Response): Promise<void> => {
    if (!requireAuth(req, res)) return;
    try {
      const backups = await listBackups(req.session!.user!.id, prisma, logger);
      res.json({ success: true, data: backups });
    } catch (err) {
      logger.error('List backups error:', err);
      res.status(500).json({ success: false, error: 'Failed to list backups' });
    }
  });

  router.get('/api/servers', async (req: Request, res: Response): Promise<void> => {
    if (!requireAuth(req, res)) return;
    try {
      const servers = await listUserServers(req.session!.user!.id, prisma, logger);
      res.json({ success: true, data: servers });
    } catch (err) {
      logger.error('List servers error:', err);
      res.status(500).json({ success: false, error: 'Failed to list servers' });
    }
  });

  router.get('/api/progress', (req: Request, res: Response): void => {
    if (!requireAuth(req, res)) return;
    res.json({ success: true, step: getProgress(req.session!.user!.id) });
  });

  router.post('/api/backup/create', async (req: Request, res: Response): Promise<void> => {
    if (!requireAuth(req, res)) return;
    try {
      const { serverUUID, name, password, passwordHint } = req.body;
      if (!serverUUID || !name) { res.status(400).json({ success: false, error: 'Missing required fields' }); return; }
      if (name.length > 100) { res.status(400).json({ success: false, error: 'Name too long (max 100 characters)' }); return; }
      if (passwordHint?.length > 200) { res.status(400).json({ success: false, error: 'Hint too long (max 200 characters)' }); return; }

      const result = await createBackup(req.session!.user!.id, serverUUID, name, password, passwordHint, prisma, logger, settingsMgr);
      result.success
        ? res.json({ success: true, data: result.data })
        : res.status(500).json({ success: false, error: result.error });
    } catch (err) {
      logger.error('Create backup error:', err);
      res.status(500).json({ success: false, error: 'Failed to create backup' });
    }
  });

  router.post('/api/backup/:id/restore', async (req: Request, res: Response): Promise<void> => {
    if (!requireAuth(req, res)) return;
    try {
      const backupId = parseInt(req.params.id, 10);
      const { serverUUID, password } = req.body;
      if (isNaN(backupId)) { res.status(400).json({ success: false, error: 'Invalid backup ID' }); return; }
      if (!serverUUID) { res.status(400).json({ success: false, error: 'Server UUID required' }); return; }

      const result = await restoreBackup(req.session!.user!.id, backupId, serverUUID, password, prisma, logger, settingsMgr);
      result.success
        ? res.json({ success: true })
        : res.status(500).json({ success: false, error: result.error });
    } catch (err) {
      logger.error('Restore error:', err);
      res.status(500).json({ success: false, error: 'Failed to restore backup' });
    }
  });

  router.post('/api/backup/:id/delete', async (req: Request, res: Response): Promise<void> => {
    if (!requireAuth(req, res)) return;
    try {
      const backupId = parseInt(req.params.id, 10);
      if (isNaN(backupId)) { res.status(400).json({ success: false, error: 'Invalid backup ID' }); return; }

      const result = await deleteBackup(req.session!.user!.id, backupId, prisma, logger, settingsMgr);
      result.success
        ? res.json({ success: true })
        : res.status(500).json({ success: false, error: result.error });
    } catch (err) {
      logger.error('Delete error:', err);
      res.status(500).json({ success: false, error: 'Failed to delete backup' });
    }
  });

  router.post('/api/backup/:id/rename', async (req: Request, res: Response): Promise<void> => {
    if (!requireAuth(req, res)) return;
    try {
      const backupId = parseInt(req.params.id, 10);
      const { name } = req.body;
      if (isNaN(backupId)) { res.status(400).json({ success: false, error: 'Invalid backup ID' }); return; }
      if (!name) { res.status(400).json({ success: false, error: 'Name required' }); return; }
      if (name.length > 100) { res.status(400).json({ success: false, error: 'Name too long (max 100 characters)' }); return; }

      const result = await renameBackup(req.session!.user!.id, backupId, name, prisma, logger);
      result.success
        ? res.json({ success: true })
        : res.status(500).json({ success: false, error: result.error });
    } catch (err) {
      logger.error('Rename error:', err);
      res.status(500).json({ success: false, error: 'Failed to rename backup' });
    }
  });

  logger.info('Parachute addon initialized');
}
