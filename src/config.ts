import type { DebugPluginConfig } from '../types';

export const DEFAULT_CONFIG: DebugPluginConfig = {
  port: 8998,
  host: '127.0.0.1',
  enableAuth: false,
  authToken: '',
};
