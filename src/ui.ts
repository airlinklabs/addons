import path from 'path';
import { Request } from 'express';
import { AddonAPI } from './types';

export function setupUI(api: AddonAPI): void {
  if (!api.ui) {
    api.logger.warn('UI API not available - skipping UI setup');
    return;
  }

  api.ui.addSidebarItem?.({
    id: 'parachute-dashboard',
    label: 'Parachute',
    icon: parachuteIcon(),
    url: '/parachute',
    section: 'main',
    order: 60,
    isAdminItem: false,
  });
}

export function isMobile(req: Request): boolean {
  return (req as unknown as Record<string, unknown> & { cookies?: Record<string, string> }).cookies?.viewport_mode === 'mobile';
}

export function resolveView(api: AddonAPI, viewName: string, mobile: boolean): string {
  const mobileView = path.join(api.mobileViewsPath, viewName);
  const desktopView = path.join(api.desktopViewsPath, viewName);
  const fallback = path.join(api.viewsPath, viewName);

  const exists = (p: string) => { try { require('fs').accessSync(p); return true; } catch { return false; } };

  if (mobile && exists(mobileView)) return mobileView;
  if (exists(desktopView)) return desktopView;
  return fallback;
}

export function getComponents(api: AddonAPI, req: Request) {
  const viewport = isMobile(req) ? 'mobile' : 'desktop';
  return {
    header: api.getComponentPath(`views/${viewport}/components/header`),
    template: api.getComponentPath(`views/${viewport}/components/template`),
    footer: api.getComponentPath(`views/${viewport}/components/footer`),
  };
}

function parachuteIcon(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
    <path d="M18.0629 9C18.0771 8.75156 18.0866 8.50313 18.0866 8.25C18.0866 5.85938 17.3306 3.75 16.1751 2.26875C15.0195 0.792188 13.5312 0 12 0C10.4688 0 8.98045 0.792188 7.82494 2.26875C6.66943 3.75 5.91335 5.85938 5.91335 8.25C5.91335 8.50313 5.92286 8.75156 5.93713 9H11.2392V15H9.71751C9.38464 15 9.06605 15.0703 8.78073 15.1969L3.06975 9H4.41547C4.4012 8.75156 4.39169 8.50313 4.39169 8.25C4.39169 5.25 5.44734 2.56875 7.10691 0.782813C2.77492 2.31094 0.71117 5.74688 0.026422 8.1375C-0.101968 8.58281 0.254671 9 0.725435 9H1.01075L7.68228 16.2328C7.52536 16.5375 7.43501 16.8844 7.43501 17.25V21.75C7.43501 22.9922 8.45738 24 9.71751 24H14.2825C15.5426 24 16.565 22.9922 16.565 21.75V17.25C16.565 16.8844 16.4746 16.5375 16.3177 16.2328L22.9893 9H23.2746C23.7453 9 24.102 8.58281 23.9736 8.1375C23.2888 5.74688 21.2251 2.31094 16.8931 0.782813C18.5527 2.56875 19.6083 5.25469 19.6083 8.25C19.6083 8.50313 19.5988 8.75156 19.5845 9H20.9303L15.2193 15.1969C14.934 15.0703 14.6154 15 14.2825 15H12.7608V9H18.0629Z"/>
    <path d="M23 9.5C23.5523 9.5 24.0067 9.05033 23.9338 8.50289C23.6468 6.34983 22.4369 4.32748 20.4853 2.78249C18.2348 1.00089 15.1826 1.90221e-07 12 0C8.8174 -1.90221e-07 5.76516 1.00089 3.51472 2.78248C1.56315 4.32748 0.353196 6.34983 0.0662425 8.50288C-0.0067195 9.05033 0.447715 9.5 1 9.5L12 9.5H23Z"/>
  </svg>`;
}
