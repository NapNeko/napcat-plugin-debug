/**
 * 全局状态管理（单例模式）
 * 参照 napcat-plugin-template 的 core/state.ts 结构
 */

import fs from 'fs';
import type { NapCatPluginContext, PluginLogger } from 'napcat-types/napcat-onebot/network/plugin/types';
import { DEFAULT_CONFIG } from '../config';
import type { DebugPluginConfig } from '../types';

class PluginState {
  private _ctx: NapCatPluginContext | null = null;
  private _config: DebugPluginConfig = { ...DEFAULT_CONFIG };
  private _logger: PluginLogger | null = null;

  get ctx () { return this._ctx; }
  get config () { return this._config; }
  get logger () { return this._logger; }

  init (ctx: NapCatPluginContext): void {
    this._ctx = ctx;
    this._logger = ctx.logger;
    this.loadConfig(ctx.configPath);
  }

  cleanup (): void {
    this._ctx = null;
    this._logger = null;
  }

  replaceConfig (config: DebugPluginConfig): void {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this.saveConfig();
  }

  private loadConfig (configPath: string): void {
    try {
      if (fs.existsSync(configPath)) {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        this._config = { ...DEFAULT_CONFIG, ...raw };
      }
    } catch {
      this._logger?.warn('配置加载失败，使用默认值');
    }
  }

  private saveConfig (): void {
    if (!this._ctx) return;
    try {
      const dir = this._ctx.configPath.replace(/[/\\][^/\\]+$/, '');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._ctx.configPath, JSON.stringify(this._config, null, 2));
    } catch {
      this._logger?.warn('配置保存失败');
    }
  }
}

export const pluginState = new PluginState();
