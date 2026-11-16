import electronUpdater from 'electron-updater';
import logger from '../logging/logger';
import { isFlatpak } from '../platform';

const { autoUpdater } = electronUpdater;

export interface UpdateInfo {
  version: string;
}

autoUpdater.logger = logger;
autoUpdater.autoDownload = false;

export const checkForUpdate = async (): Promise<UpdateInfo | false> => {
  if (isFlatpak) {
    logger.info('Updates are managed by Flatpak, skipping update check');
    return false;
  }
  return new Promise<UpdateInfo | false>((resolve, reject) => {
    autoUpdater.once('error', reject);
    autoUpdater.once('update-available', (info: UpdateInfo) => resolve(info));
    autoUpdater.once('update-not-available', () => resolve(false));
    autoUpdater.checkForUpdates();
  });
};

export const downloadUpdate = async (): Promise<electronUpdater.UpdateDownloadedEvent> => {
  if (isFlatpak) {
    throw new Error('Updates are managed by Flatpak, not by the app');
  }
  return new Promise<electronUpdater.UpdateDownloadedEvent>((resolve, reject) => {
    autoUpdater.once('error', reject);
    autoUpdater.once('update-downloaded', resolve);
    autoUpdater.downloadUpdate();
  });
};

export const quitAndInstall = (): void => {
  if (isFlatpak) {
    return;
  }
  logger.info('Quitting and installing update');
  setImmediate(() => autoUpdater.quitAndInstall());
};
