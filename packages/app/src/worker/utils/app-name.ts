import { DEFAULT_APP_NAME } from '../../shared/app-settings';
import { getAppSettingCached } from './app-settings-cache';

export async function getAppName(env: Env): Promise<string> {
	const appName = await getAppSettingCached(env, 'app_name');
	const trimmedAppName = appName?.trim();
	return trimmedAppName === '' || trimmedAppName == null ? DEFAULT_APP_NAME : trimmedAppName;
}
