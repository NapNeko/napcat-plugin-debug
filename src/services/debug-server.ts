/**
 * WebSocket 调试服务器
 *
 * 使用简单的 JSON-RPC 2.0 协议，将 IPluginManager 的所有 API 暴露给 CLI。
 * 不依赖 napcat-rpc（避免复杂的 monorepo 依赖），直接用 JSON-RPC over WebSocket。
 */

import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { DebugPluginConfig, RpcRequest, RpcResponse, RemotePluginInfo } from '../types';
import { pluginState } from '../core/state';

export class DebugServer {
  private wss: any = null;
  private clients = new Set<any>();
  private ctx: NapCatPluginContext;
  private config: DebugPluginConfig;

  constructor(ctx: NapCatPluginContext, config: DebugPluginConfig) {
    this.ctx = ctx;
    this.config = config;
  }

  async start(): Promise<void> {
    // 禁用 bufferutil 可选依赖，避免在打包环境中 bufferUtil.unmask 报错
    process.env.WS_NO_BUFFER_UTIL = '1';
    process.env.WS_NO_UTF_8_VALIDATE = '1';
    // ws 在 NapCat 运行环境中可用（NapCat 的根 dependencies 包含 ws）
    const { WebSocketServer } = await import('ws');

    this.wss = new WebSocketServer({
      port: this.config.port,
      host: this.config.host,
    });

    this.wss.on('connection', (ws: any, req: any) => {
      // 认证
      if (this.config.enableAuth && this.config.authToken) {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const token = url.searchParams.get('token') || req.headers['authorization']?.replace('Bearer ', '');
        if (token !== this.config.authToken) {
          ws.close(4001, 'Unauthorized');
          this.ctx.logger.warn('CLI 连接被拒绝：token 无效');
          return;
        }
      }

      this.ctx.logger.info(`CLI 客户端已连接: ${req.socket.remoteAddress}`);
      this.clients.add(ws);

      ws.on('message', async (raw: any) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.jsonrpc === '2.0' && msg.method) {
            const response = await this.handleRpc(msg as RpcRequest);
            ws.send(JSON.stringify(response));
          }
        } catch { /* 忽略格式错误 */ }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        this.ctx.logger.info('CLI 客户端已断开');
      });

      ws.on('error', (err: Error) => {
        this.ctx.logger.error('WebSocket 错误:', err.message);
        this.clients.delete(ws);
      });

      // 欢迎消息
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'welcome',
        params: {
          version: '1.0.0',
          pluginCount: this.ctx.pluginManager.getAllPlugins().length,
        },
      }));
    });

    this.wss.on('error', (err: Error) => {
      this.ctx.logger.error('WS 服务器错误:', err.message);
    });

    this.ctx.logger.info(`调试服务已启动: ws://${this.config.host}:${this.config.port}`);
  }

  async stop(): Promise<void> {
    if (!this.wss) return;
    for (const c of this.clients) {
      try { c.close(1000, 'Server stopping'); } catch { /* */ }
    }
    this.clients.clear();
    await new Promise<void>(r => this.wss.close(() => r()));
    this.wss = null;
    this.ctx.logger.info('调试服务已停止');
  }

  broadcastEvent(event: unknown): void {
    const msg = JSON.stringify({
      jsonrpc: '2.0',
      method: 'event',
      params: event,
    });
    for (const c of this.clients) {
      try { if (c.readyState === 1) c.send(msg); } catch { /* */ }
    }
  }

  // ==================== 自身插件 ID ====================

  private static readonly SELF_PLUGIN_ID = 'napcat-plugin-debug';

  // ==================== JSON-RPC 方法路由 ====================

  private async handleRpc(req: RpcRequest): Promise<RpcResponse> {
    const pm = this.ctx.pluginManager;
    const params = req.params || [];

    try {
      let result: unknown;

      switch (req.method) {
        case 'ping':
          result = 'pong';
          break;

        case 'getDebugInfo':
          result = {
            version: '1.0.0',
            pluginCount: pm.getAllPlugins().length,
            loadedCount: pm.getLoadedPlugins().length,
            pluginPath: pm.getPluginPath(),
            uptime: process.uptime(),
          };
          break;

        case 'getPluginPath':
          result = pm.getPluginPath();
          break;

        case 'getAllPlugins':
          result = pm.getAllPlugins().map(e => this.serializeEntry(e));
          break;

        case 'getLoadedPlugins':
          result = pm.getLoadedPlugins().map(e => ({
            id: e.id, name: e.name, version: e.version, loaded: e.loaded
          }));
          break;

        case 'getPluginInfo':
          const info = pm.getPluginInfo(params[0] as string);
          result = info ? this.serializeEntry(info) : null;
          break;

        case 'setPluginStatus':
          await pm.setPluginStatus(params[0] as string, params[1] as boolean);
          result = true;
          break;

        case 'loadPluginById':
          result = await pm.loadPluginById(params[0] as string);
          break;

        case 'unregisterPlugin': {
          const targetId = params[0] as string;
          if (targetId === DebugServer.SELF_PLUGIN_ID) {
            return {
              jsonrpc: '2.0', id: req.id,
              error: { code: -32001, message: '不能通过调试服务卸载自身 (napcat-plugin-debug)' },
            };
          }
          await pm.unregisterPlugin(targetId);
          result = true;
          break;
        }

        case 'reloadPlugin': {
          const targetId = params[0] as string;
          if (targetId === DebugServer.SELF_PLUGIN_ID) {
            return {
              jsonrpc: '2.0', id: req.id,
              error: { code: -32001, message: '不能通过调试服务重载自身 (napcat-plugin-debug)' },
            };
          }
          result = await pm.reloadPlugin(targetId);
          break;
        }

        case 'scanPlugins':
          result = await pm.scanPlugins();
          break;

        case 'loadDirectoryPlugin':
          await pm.loadDirectoryPlugin(params[0] as string);
          result = true;
          break;

        case 'uninstallPlugin': {
          const targetId = params[0] as string;
          if (targetId === DebugServer.SELF_PLUGIN_ID) {
            return {
              jsonrpc: '2.0', id: req.id,
              error: { code: -32001, message: '不能通过调试服务卸载自身 (napcat-plugin-debug)' },
            };
          }
          await pm.uninstallPlugin(targetId, params[1] as boolean);
          result = true;
          break;
        }

        case 'getPluginDataPath':
          result = pm.getPluginDataPath(params[0] as string);
          break;

        case 'getPluginConfigPath':
          result = pm.getPluginConfigPath(params[0] as string);
          break;

        case 'getPluginConfig':
          result = pm.getPluginConfig();
          break;

        default:
          return {
            jsonrpc: '2.0', id: req.id,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          };
      }

      return { jsonrpc: '2.0', id: req.id, result };
    } catch (err: any) {
      return {
        jsonrpc: '2.0', id: req.id,
        error: { code: -32000, message: err.message || String(err) },
      };
    }
  }

  private serializeEntry(e: any): RemotePluginInfo {
    return {
      id: e.id,
      fileId: e.fileId,
      name: e.name,
      version: e.version,
      description: e.description,
      author: e.author,
      pluginPath: e.pluginPath,
      entryPath: e.entryPath,
      enable: e.enable,
      loaded: e.loaded,
      runtimeStatus: e.runtime?.status,
      runtimeError: e.runtime?.error,
    };
  }
}
