/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import * as Sentry from '@sentry/node';
import { execAsync, pathExists } from '@runtipi/shared';
import { SocketEvent } from '@runtipi/shared/src/schemas/socket';
import { copyDataDir, generateEnvFile } from './app.helpers';
import { logger } from '@/lib/logger';
import { compose } from '@/lib/docker';
import { getEnv } from '@/lib/environment';
import { ROOT_FOLDER, STORAGE_FOLDER } from '@/config/constants';
import { SocketManager } from '@/lib/socket/SocketManager';

const getDbClient = async () => {
  const { postgresHost, postgresDatabase, postgresUsername, postgresPassword, postgresPort } = getEnv();

  const client = new pg.Client({
    host: postgresHost,
    database: postgresDatabase,
    user: postgresUsername,
    password: postgresPassword,
    port: Number(postgresPort),
  });

  await client.connect();

  return client;
};

export class AppExecutors {
  private readonly logger;

  constructor() {
    this.logger = logger;
  }

  private handleAppError = (err: unknown, appId: string, event: Extract<SocketEvent, { type: 'app' }>['event']) => {
    Sentry.captureException(err);

    if (err instanceof Error) {
      SocketManager.emit({ type: 'app', event, data: { appId, error: err.message } });
      this.logger.error(`An error occurred: ${err.message}`);
      return { success: false, message: err.message };
    }

    SocketManager.emit({ type: 'app', event, data: { appId, error: String(err) } });
    return { success: false, message: `An error occurred: ${err}` };
  };

  private getAppPaths = (appId: string) => {
    const { appsRepoId } = getEnv();

    const appDataDirPath = path.join(STORAGE_FOLDER, 'app-data', appId);
    const appDirPath = path.join(ROOT_FOLDER, 'apps', appId);
    const configJsonPath = path.join(appDirPath, 'config.json');
    const repoPath = path.join(ROOT_FOLDER, 'repos', appsRepoId, 'apps', appId);

    return { appDataDirPath, appDirPath, configJsonPath, repoPath };
  };

  /**
   * Given an app id, ensures that the app folder exists in the apps folder
   * If not, copies the app folder from the repo
   * @param {string} appId - App id
   */
  private ensureAppDir = async (appId: string) => {
    const { appDirPath, repoPath } = this.getAppPaths(appId);
    const dockerFilePath = path.join(ROOT_FOLDER, 'apps', appId, 'docker-compose.yml');

    if (!(await pathExists(dockerFilePath))) {
      // delete eventual app folder if exists
      this.logger.info(`Deleting app ${appId} folder if exists`);
      await fs.promises.rm(appDirPath, { recursive: true, force: true });

      // Copy app folder from repo
      this.logger.info(`Copying app ${appId} from repo ${getEnv().appsRepoId}`);
      await fs.promises.cp(repoPath, appDirPath, { recursive: true });
    }
  };

  public regenerateAppEnv = async (appId: string, config: Record<string, unknown>) => {
    try {
      this.logger.info(`Regenerating app.env file for app ${appId}`);
      await this.ensureAppDir(appId);
      await generateEnvFile(appId, config);

      SocketManager.emit({ type: 'app', event: 'generate_env_success', data: { appId } });
      return { success: true, message: `App ${appId} env file regenerated successfully` };
    } catch (err) {
      return this.handleAppError(err, appId, 'generate_env_error');
    }
  };

  /**
   * Install an app from the repo
   * @param {string} appId - The id of the app to install
   * @param {Record<string, unknown>} config - The config of the app
   */
  public installApp = async (appId: string, config: Record<string, unknown>) => {
    try {
      SocketManager.emit({ type: 'app', event: 'status_change', data: { appId } });

      if (process.getuid && process.getgid) {
        this.logger.info(`Installing app ${appId} as User ID: ${process.getuid()}, Group ID: ${process.getgid()}`);
      } else {
        this.logger.info(`Installing app ${appId}. No User ID or Group ID found.`);
      }

      const { appsRepoId } = getEnv();

      const { appDirPath, repoPath, appDataDirPath } = this.getAppPaths(appId);

      // Check if app exists in repo
      const apps = await fs.promises.readdir(path.join(ROOT_FOLDER, 'repos', appsRepoId, 'apps'));

      if (!apps.includes(appId)) {
        this.logger.error(`App ${appId} not found in repo ${appsRepoId}`);
        return { success: false, message: `App ${appId} not found in repo ${appsRepoId}` };
      }

      // Delete app folder if exists
      this.logger.info(`Deleting folder ${appDirPath} if exists`);
      await fs.promises.rm(appDirPath, { recursive: true, force: true });

      // Create app folder
      this.logger.info(`Creating folder ${appDirPath}`);
      await fs.promises.mkdir(appDirPath, { recursive: true });

      // Copy app folder from repo
      this.logger.info(`Copying folder ${repoPath} to ${appDirPath}`);
      await fs.promises.cp(repoPath, appDirPath, { recursive: true });

      // Create folder app-data folder
      this.logger.info(`Creating folder ${appDataDirPath}`);
      await fs.promises.mkdir(appDataDirPath, { recursive: true });

      // Create app.env file
      this.logger.info(`Creating app.env file for app ${appId}`);
      await generateEnvFile(appId, config);

      // Copy data dir
      this.logger.info(`Copying data dir for app ${appId}`);
      if (!(await pathExists(`${appDataDirPath}/data`))) {
        await copyDataDir(appId);
      }

      await execAsync(`chmod -R a+rwx ${path.join(appDataDirPath)}`).catch(() => {
        this.logger.error(`Error setting permissions for app ${appId}`);
      });

      // run docker-compose up
      this.logger.info(`Running docker-compose up for app ${appId}`);
      await compose(appId, 'up -d');

      this.logger.info(`Docker-compose up for app ${appId} finished`);

      SocketManager.emit({ type: 'app', event: 'install_success', data: { appId } });

      return { success: true, message: `App ${appId} installed successfully` };
    } catch (err) {
      return this.handleAppError(err, appId, 'install_error');
    }
  };

  /**
   * Stops an app
   * @param {string} appId - The id of the app to stop
   * @param {Record<string, unknown>} config - The config of the app
   */
  public stopApp = async (appId: string, config: Record<string, unknown>, skipEnvGeneration = false) => {
    try {
      SocketManager.emit({ type: 'app', event: 'status_change', data: { appId } });
      this.logger.info(`Stopping app ${appId}`);

      await this.ensureAppDir(appId);

      if (!skipEnvGeneration) {
        this.logger.info(`Regenerating app.env file for app ${appId}`);
        await generateEnvFile(appId, config);
      }
      await compose(appId, 'rm --force --stop');

      this.logger.info(`App ${appId} stopped`);

      SocketManager.emit({ type: 'app', event: 'stop_success', data: { appId } });

      return { success: true, message: `App ${appId} stopped successfully` };
    } catch (err) {
      return this.handleAppError(err, appId, 'stop_error');
    }
  };

  public startApp = async (appId: string, config: Record<string, unknown>, skipEnvGeneration = false) => {
    try {
      SocketManager.emit({ type: 'app', event: 'status_change', data: { appId } });

      const { appDataDirPath } = this.getAppPaths(appId);

      this.logger.info(`Starting app ${appId}`);

      await this.ensureAppDir(appId);

      if (!skipEnvGeneration) {
        this.logger.info(`Regenerating app.env file for app ${appId}`);
        await generateEnvFile(appId, config);
      }

      await compose(appId, 'up --detach --force-recreate --remove-orphans --pull always');

      this.logger.info(`App ${appId} started`);

      this.logger.info(`Setting permissions for app ${appId}`);
      await execAsync(`chmod -R a+rwx ${path.join(appDataDirPath)}`).catch(() => {
        this.logger.error(`Error setting permissions for app ${appId}`);
      });

      SocketManager.emit({ type: 'app', event: 'start_success', data: { appId } });

      return { success: true, message: `App ${appId} started successfully` };
    } catch (err) {
      return this.handleAppError(err, appId, 'start_error');
    }
  };

  public uninstallApp = async (appId: string, config: Record<string, unknown>) => {
    try {
      SocketManager.emit({ type: 'app', event: 'status_change', data: { appId } });

      const { appDirPath, appDataDirPath } = this.getAppPaths(appId);
      this.logger.info(`Uninstalling app ${appId}`);

      this.logger.info(`Regenerating app.env file for app ${appId}`);
      await this.ensureAppDir(appId);
      await generateEnvFile(appId, config);
      try {
        await compose(appId, 'down --remove-orphans --volumes --rmi all');
      } catch (err) {
        if (err instanceof Error && err.message.includes('conflict')) {
          this.logger.warn(`Could not fully uninstall app ${appId}. Some images are in use by other apps. Consider cleaning unused images docker system prune -a`);
        } else {
          throw err;
        }
      }

      this.logger.info(`Deleting folder ${appDirPath}`);
      await fs.promises.rm(appDirPath, { recursive: true, force: true }).catch((err) => {
        this.logger.error(`Error deleting folder ${appDirPath}: ${err.message}`);
      });

      this.logger.info(`Deleting folder ${appDataDirPath}`);
      await fs.promises.rm(appDataDirPath, { recursive: true, force: true }).catch((err) => {
        this.logger.error(`Error deleting folder ${appDataDirPath}: ${err.message}`);
      });

      this.logger.info(`App ${appId} uninstalled`);

      SocketManager.emit({ type: 'app', event: 'uninstall_success', data: { appId } });

      return { success: true, message: `App ${appId} uninstalled successfully` };
    } catch (err) {
      return this.handleAppError(err, appId, 'uninstall_error');
    }
  };

  public updateApp = async (appId: string, config: Record<string, unknown>) => {
    try {
      SocketManager.emit({ type: 'app', event: 'status_change', data: { appId } });

      const { appDirPath, repoPath } = this.getAppPaths(appId);
      this.logger.info(`Updating app ${appId}`);
      await this.ensureAppDir(appId);
      await generateEnvFile(appId, config);

      try {
        await compose(appId, 'up --detach --force-recreate --remove-orphans');
        await compose(appId, 'down --rmi all --remove-orphans');
      } catch (err) {
        logger.warn(`App ${appId} has likely a broken docker-compose.yml file. Continuing with update...`);
      }

      this.logger.info(`Deleting folder ${appDirPath}`);
      await fs.promises.rm(appDirPath, { recursive: true, force: true });

      this.logger.info(`Copying folder ${repoPath} to ${appDirPath}`);
      await fs.promises.cp(repoPath, appDirPath, { recursive: true });

      await compose(appId, 'pull');

      SocketManager.emit({ type: 'app', event: 'update_success', data: { appId } });

      return { success: true, message: `App ${appId} updated successfully` };
    } catch (err) {
      return this.handleAppError(err, appId, 'update_error');
    }
  };

  /**
   * Start all apps with status running
   */
  public startAllApps = async () => {
    const client = await getDbClient();

    try {
      // Get all apps with status running
      const { rows } = await client.query(`SELECT * FROM app WHERE status = 'running'`);

      // Update all apps with status different than running or stopped to stopped
      await client.query(`UPDATE app SET status = 'stopped' WHERE status != 'stopped' AND status != 'running' AND status != 'missing'`);

      // Start all apps
      for (const row of rows) {
        const { id, config } = row;

        const { success } = await this.startApp(id, config);

        if (!success) {
          this.logger.error(`Error starting app ${id}`);
          await client.query(`UPDATE app SET status = 'stopped' WHERE id = '${id}'`);
        } else {
          await client.query(`UPDATE app SET status = 'running' WHERE id = '${id}'`);
        }
      }
    } catch (err) {
      this.logger.error(`Error starting apps: ${err}`);
    } finally {
      await client.end();
    }
  };
}
