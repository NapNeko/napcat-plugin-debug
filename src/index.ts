/**
 * napcat-plugin-debug — 插件调试服务
 *
 * 启动后开启 WebSocket 调试服务器，将 PluginManager 的所有接口暴露出去。
 * 外部 CLI 工具连接 WebSocket 后即可管理插件、实现热重载。
 *
 * 架构：
 *   NapCat
 *     └─ 本插件 → WebSocket Server (:8998)
 *                    └─ JSON-RPC 协议
 *                        └─ CLI 客户端连接
 *                            └─ 文件监听 + 热重载
 */

import type {
  PluginModule,
  PluginConfigSchema,
  NapCatPluginContext,
  PluginLogger,
} from 'napcat-types/napcat-onebot/network/plugin/types';

import { pluginState } from './core/state';
import { DebugServer } from './services/debug-server';

// ======================== 配置 UI Schema ========================

export let plugin_config_ui: PluginConfigSchema = [];

// ======================== 调试服务实例 ========================

let debugServer: DebugServer | null = null;

// ======================== 生命周期函数 ========================

export const plugin_init: PluginModule['plugin_init'] = async (ctx) => {
  pluginState.init(ctx);

  ctx.logger.info('插件调试服务初始化中...');

  // 生成配置 Schema
  plugin_config_ui = ctx.NapCatConfig.combine(
    ctx.NapCatConfig.html(`
      <div style="padding:12px;background:linear-gradient(135deg,#667eea,#764ba2);border-radius:12px;margin-bottom:20px;color:white">
        <h3 style="margin:0 0 8px;font-size:18px;font-weight:bold">🔧 插件调试服务</h3>
        <p style="margin:0;font-size:14px;opacity:0.9">启动 WebSocket 调试服务器，配合 CLI 工具实现插件热重载。</p>
      </div>
    `),
    ctx.NapCatConfig.number('port', '调试服务端口', 8998, 'WebSocket 监听端口'),
    ctx.NapCatConfig.text('host', '监听地址', '127.0.0.1', '建议仅监听 127.0.0.1'),
    ctx.NapCatConfig.boolean('enableAuth', '启用认证', false, '启用后客户端需提供 token'),
    ctx.NapCatConfig.text('authToken', '认证 Token', '', '客户端连接时的认证 token'),
  );

  // 启动调试服务器
  debugServer = new DebugServer(ctx, pluginState.config);
  await debugServer.start();

  ctx.logger.info('插件调试服务就绪');
  ctx.logger.info(`CLI 连接: node cli.mjs ws://${pluginState.config.host}:${pluginState.config.port}`);
};

export const plugin_onmessage: PluginModule['plugin_onmessage'] = async (_ctx, event) => {
  debugServer?.broadcastEvent({ eventType: 'message', ...safeSerialize(event) });
};

export const plugin_onevent: PluginModule['plugin_onevent'] = async (_ctx, event) => {
  debugServer?.broadcastEvent({ eventType: 'notify', ...safeSerialize(event) });
};

export const plugin_cleanup: PluginModule['plugin_cleanup'] = async (ctx) => {
  ctx.logger.info('停止调试服务...');
  await debugServer?.stop();
  debugServer = null;
  pluginState.cleanup();
};

export const plugin_get_config: PluginModule['plugin_get_config'] = async () => {
  return pluginState.config;
};

export const plugin_set_config: PluginModule['plugin_set_config'] = async (_ctx, config) => {
  pluginState.replaceConfig(config as any);

  // 重启服务器
  await debugServer?.stop();
  debugServer = new DebugServer(pluginState.ctx!, pluginState.config);
  await debugServer.start();
};

// ======================== 工具函数 ========================

function safeSerialize (obj: any): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return { raw: String(obj) };
  }
}
