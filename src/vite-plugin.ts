/**
 * napcat-plugin-debug Vite 插件
 *
 * 集成到 Vite 构建流程中，在 `writeBundle` (每次构建完成) 时自动：
 *   1. 连接 NapCat 调试 WebSocket 服务
 *   2. 获取远程插件目录路径
 *   3. 将 dist/ 复制到远程插件目录
 *   4. 调用 reloadPlugin 热重载插件
 *
 * 用法 (vite.config.ts)：
 *   import { napcatHmrPlugin } from 'napcat-plugin-debug-cli/vite'
 *   export default defineConfig({
 *     plugins: [napcatHmrPlugin()],
 *     build: { watch: {} },   // 开启 watch 模式
 *   })
 *
 * 配合 `vite build --watch`，一条命令即可实现：
 *   源码修改 → Vite 自动重新构建 → 插件自动部署 → NapCat 热重载
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

// ======================== 类型 ========================

export interface NapcatHmrPluginOptions {
    /** WebSocket 调试服务地址 (默认: ws://127.0.0.1:8998) */
    wsUrl?: string;
    /** 认证 token */
    token?: string;
    /** 是否启用 (默认: true) */
    enabled?: boolean;
    /** 首次构建完成后是否自动连接 (默认: true) */
    autoConnect?: boolean;
}

interface RpcRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: unknown[];
}

// ======================== 颜色输出 ========================

const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

const co = (t: string, ...c: string[]) => c.join('') + t + C.reset;

const PREFIX = co('[napcat-hmr]', C.magenta, C.bold);
const log = (m: string) => console.log(`${PREFIX} ${m}`);
const logOk = (m: string) => console.log(`${PREFIX} ${co('✓', C.green)} ${m}`);
const logErr = (m: string) => console.log(`${PREFIX} ${co('✗', C.red)} ${m}`);
const logHmr = (m: string) => console.log(`${PREFIX} ${co('🔥', C.magenta)} ${co(m, C.magenta)}`);

// ======================== 简易 JSON-RPC 客户端 ========================

class SimpleRpcClient {
    private ws: any;
    private nextId = 1;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

    constructor(ws: any) {
        this.ws = ws;
        ws.on('message', (raw: any) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.jsonrpc === '2.0' && msg.id != null) {
                    const p = this.pending.get(msg.id);
                    if (p) {
                        this.pending.delete(msg.id);
                        if (msg.error) p.reject(new Error(msg.error.message));
                        else p.resolve(msg.result);
                    }
                }
            } catch { /* 忽略格式错误 */ }
        });
    }

    call(method: string, ...params: unknown[]): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            const req: RpcRequest = { jsonrpc: '2.0', id, method, params };
            this.ws.send(JSON.stringify(req));
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error('RPC timeout'));
                }
            }, 10000);
        });
    }

    get connected(): boolean {
        return this.ws?.readyState === 1;
    }

    close() {
        try { this.ws?.close(1000); } catch { /* */ }
    }
}

// ======================== 工具函数 ========================

function copyDirRecursive(src: string, dest: string) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
        else fs.copyFileSync(srcPath, destPath);
    }
}

function countFiles(dir: string): number {
    let count = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
        else count++;
    }
    return count;
}

// ======================== Vite 插件 ========================

export function napcatHmrPlugin(options: NapcatHmrPluginOptions = {}): Plugin {
    const {
        wsUrl = 'ws://127.0.0.1:8998',
        token,
        enabled = true,
        autoConnect = true,
    } = options;

    let rpc: SimpleRpcClient | null = null;
    let remotePluginPath: string | null = null;
    let connecting = false;
    let config: ResolvedConfig;
    let isFirstBuild = true;

    /**
     * 连接到调试服务
     */
    async function connect(): Promise<boolean> {
        if (rpc?.connected) return true;
        if (connecting) return false;
        connecting = true;

        try {
            // 动态 import ws — 在 NapCat/Node.js 环境下 ws 可用
            const { default: WebSocket } = await import('ws');

            let url = wsUrl;
            if (token) {
                const u = new URL(url);
                u.searchParams.set('token', token);
                url = u.toString();
            }

            return await new Promise<boolean>((resolve) => {
                const ws = new WebSocket(url);
                const timeout = setTimeout(() => {
                    ws.close();
                    connecting = false;
                    resolve(false);
                }, 5000);

                ws.on('open', () => {
                    clearTimeout(timeout);
                });

                ws.on('message', async (raw: any) => {
                    try {
                        const msg = JSON.parse(raw.toString());
                        if (msg.method === 'welcome') {
                            rpc = new SimpleRpcClient(ws);
                            try {
                                const info = await rpc.call('getDebugInfo');
                                remotePluginPath = info.pluginPath;
                                logOk(`已连接调试服务 (${info.loadedCount}/${info.pluginCount} 插件)`);
                                log(`远程插件目录: ${co(info.pluginPath, C.dim)}`);
                            } catch { /* */ }
                            connecting = false;
                            resolve(true);
                        }
                    } catch { /* */ }
                });

                ws.on('error', () => {
                    clearTimeout(timeout);
                    connecting = false;
                    resolve(false);
                });

                ws.on('close', () => {
                    rpc = null;
                    remotePluginPath = null;
                    connecting = false;
                });
            });
        } catch (e: any) {
            connecting = false;
            return false;
        }
    }

    /**
     * 部署 dist → 远程插件目录 → 重载
     */
    async function deployAndReload(distDir: string): Promise<void> {
        if (!rpc?.connected || !remotePluginPath) {
            logErr('未连接到调试服务，跳过部署');
            return;
        }

        // 读取插件名
        const pkgPath = path.join(distDir, 'package.json');
        if (!fs.existsSync(pkgPath)) {
            logErr('dist/package.json 不存在，跳过部署');
            return;
        }

        let pluginName: string;
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            pluginName = pkg.name;
            if (!pluginName) {
                logErr('dist/package.json 中缺少 name 字段');
                return;
            }
        } catch {
            logErr('解析 dist/package.json 失败');
            return;
        }

        const destDir = path.join(remotePluginPath, pluginName);

        // 复制文件
        try {
            if (fs.existsSync(destDir)) {
                fs.rmSync(destDir, { recursive: true, force: true });
            }
            copyDirRecursive(distDir, destDir);
        } catch (e: any) {
            logErr(`复制文件失败: ${e.message}`);
            return;
        }

        // 重载插件
        try {
            await rpc.call('reloadPlugin', pluginName);
            logHmr(`${co(pluginName, C.green, C.bold)} 已重载 (${countFiles(distDir)} 个文件)`);
        } catch {
            // 首次加载
            try {
                await rpc.call('loadDirectoryPlugin', destDir);
                logOk(`${co(pluginName, C.green, C.bold)} 首次加载成功`);
            } catch (e2: any) {
                logErr(`加载失败: ${e2.message}`);
            }
        }
    }

    return {
        name: 'napcat-hmr',
        apply: 'build',

        configResolved(resolvedConfig) {
            config = resolvedConfig;
        },

        async buildStart() {
            if (!enabled) return;
            if (!autoConnect) return;

            // 首次构建时连接
            if (isFirstBuild) {
                log(`连接 ${co(wsUrl, C.cyan)}...`);
                const ok = await connect();
                if (!ok) {
                    logErr(`无法连接调试服务 ${wsUrl}`);
                    log('请确认 napcat-plugin-debug 已启用');
                    log('仅构建模式，不自动部署');
                }
            }
        },

        async writeBundle() {
            if (!enabled) return;

            const distDir = path.resolve(config.build.outDir);

            // 如果未连接，尝试重连
            if (!rpc?.connected) {
                const ok = await connect();
                if (!ok) return;
            }

            await deployAndReload(distDir);
            isFirstBuild = false;
        },

        closeBundle() {
            // watch 模式下不关闭连接（Vite 会持续运行）
            if (config.build.watch) return;
            rpc?.close();
            rpc = null;
        },
    };
}

export default napcatHmrPlugin;
