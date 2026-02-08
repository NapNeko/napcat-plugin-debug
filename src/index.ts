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
      <div style="padding:16px 20px;background:#1a1a2e;border:1px solid #30305a;border-radius:8px;margin-bottom:16px;color:#e0e0e0;font-family:system-ui,-apple-system,sans-serif">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7c8aff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.855z"/></svg>
          <span style="font-size:16px;font-weight:600;color:#fff">Plugin Debug Service</span>
        </div>
        <p style="margin:0;font-size:13px;line-height:1.6;color:#a0a0b8">
          WebSocket 调试服务器，通过 JSON-RPC 协议暴露插件管理接口，配合 Vite 插件或 CLI 工具实现插件热重载开发。
        </p>
      </div>
    `),
    ctx.NapCatConfig.number('port', '调试服务端口', 8998, 'WebSocket 监听端口'),
    ctx.NapCatConfig.text('host', '监听地址', '127.0.0.1', '仅限本地调试时使用 127.0.0.1；改为 0.0.0.0 会暴露在网络中，存在安全风险'),
    ctx.NapCatConfig.html(`
      <div style="padding:10px 14px;background:#2a1a1a;border-left:3px solid #e74c3c;border-radius:4px;margin:8px 0;font-family:system-ui,-apple-system,sans-serif">
        <p style="margin:0;font-size:12px;line-height:1.6;color:#e8a0a0">
          <strong style="color:#f0c0c0">安全提示：</strong>默认不启用认证，任何能访问该端口的客户端均可执行插件管理操作（加载、卸载、重载插件等）。
          如需远程调试，请务必启用认证并设置高强度 Token，同时通过防火墙限制来源 IP。建议优先使用 SSH 隧道转发端口。
        </p>
      </div>
    `),
    ctx.NapCatConfig.boolean('enableAuth', '启用认证', false, '启用后客户端需提供 Token 才能连接，强烈建议远程调试时开启'),
    ctx.NapCatConfig.text('authToken', '认证 Token', '', '客户端连接时的认证凭据，请使用高强度随机字符串'),
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

function safeSerialize(obj: any): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return { raw: String(obj) };
  }
}
