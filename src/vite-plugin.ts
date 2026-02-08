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
import { execSync } from 'node:child_process';
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
    /**
     * WebUI 配置 — 支持 Vite+React / 纯 HTML 等前端子项目
     *
     * 设置后，每次主插件构建完成时会：
     *   1. 执行 WebUI 的构建命令（如果配置了 buildCommand）
     *   2. 将 WebUI 产物目录复制到部署目标的指定子目录
     *
     * 示例 (Vite+React WebUI)：
     *   webui: {
     *     root: './webui',
     *     buildCommand: 'npm run build',
     *     distDir: './webui/dist',
     *     targetDir: 'webui',
     *   }
     *
     * 示例 (纯 HTML)：
     *   webui: {
     *     distDir: './webui',
     *     targetDir: 'webui',
     *   }
     */
    webui?: WebuiConfig | WebuiConfig[];
}

export interface WebuiConfig {
    /**
     * WebUI 项目根目录（用于执行构建命令的 cwd）
     * 相对于 Vite 项目根目录，默认为 distDir 所在目录
     */
    root?: string;
    /**
     * 构建命令（如 'npm run build'、'pnpm build' 等）
     * 不设置则跳过构建，只复制 distDir 的内容
     */
    buildCommand?: string;
    /**
     * WebUI 构建产物目录（相对于 Vite 项目根目录）
     * 这个目录的内容会被复制到部署目标
     */
    distDir: string;
    /**
     * 部署到远程插件目录中的子目录名（默认: 'webui'）
     * 例如设为 'webui'，则产物会被复制到 <pluginDir>/webui/
     */
    targetDir?: string;
    /**
     * WebUI 源码监听目录（相对于 Vite 项目根目录）
     *
     * 在 `vite build --watch` 模式下，后端 Vite 只监听后端入口的依赖图，
     * WebUI 源码的变化不会触发后端重新构建。
     *
     * 设置此项后，插件会独立监听该目录，检测到文件变化时自动：
     *   1. 执行 buildCommand（如果配置了）
     *   2. 将 distDir 产物复制到远程部署目录
     *   3. 触发插件重载
     *
     * 示例：watchDir: './src/webui/src'
     */
    watchDir?: string;
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
const logOk = (m: string) => console.log(`${PREFIX} ${co('(o\'v\'o)', C.green)} ${m}`);
const logErr = (m: string) => console.log(`${PREFIX} ${co('(;_;)', C.red)} ${m}`);
const logHmr = (m: string) => console.log(`${PREFIX} ${co('(&gt;&lt;)', C.yellow)} ${co(m, C.magenta)}`);

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
        webui,
    } = options;

    // 标准化 webui 配置为数组
    const webuiConfigs: WebuiConfig[] = webui
        ? (Array.isArray(webui) ? webui : [webui])
        : [];

    let rpc: SimpleRpcClient | null = null;
    let remotePluginPath: string | null = null;
    let connecting = false;
    let config: ResolvedConfig;
    let isFirstBuild = true;
    const webuiWatchers: fs.FSWatcher[] = [];
    let webuiDeployDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * 连接到调试服务
     */
    async function connect(): Promise<boolean> {
        if (rpc?.connected) return true;
        if (connecting) return false;
        connecting = true;

        try {
            // 禁用 bufferutil 可选依赖，避免打包环境兼容问题
            process.env.WS_NO_BUFFER_UTIL = '1';
            process.env.WS_NO_UTF_8_VALIDATE = '1';
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

        // 复制主构建产物
        try {
            if (fs.existsSync(destDir)) {
                fs.rmSync(destDir, { recursive: true, force: true });
            }
            copyDirRecursive(distDir, destDir);
        } catch (e: any) {
            logErr(`复制文件失败: ${e.message}`);
            return;
        }

        // 处理 WebUI 构建和部署
        const projectRoot = config.root || process.cwd();
        for (const wc of webuiConfigs) {
            const webuiTargetDir = wc.targetDir || 'webui';
            const webuiDistDir = path.resolve(projectRoot, wc.distDir);
            const webuiRoot = wc.root ? path.resolve(projectRoot, wc.root) : path.dirname(webuiDistDir);

            // 执行 WebUI 构建命令
            if (wc.buildCommand) {
                try {
                    log(`构建 WebUI (${co(webuiTargetDir, C.cyan)})...`);
                    execSync(wc.buildCommand, {
                        cwd: webuiRoot,
                        stdio: 'pipe',
                        env: { ...process.env, NODE_ENV: 'production' },
                    });
                    logOk(`WebUI (${webuiTargetDir}) 构建完成`);
                } catch (e: any) {
                    logErr(`WebUI (${webuiTargetDir}) 构建失败: ${e.stderr?.toString() || e.message}`);
                    continue;
                }
            }

            // 复制 WebUI 产物到部署目录
            if (!fs.existsSync(webuiDistDir)) {
                logErr(`WebUI 产物目录不存在: ${webuiDistDir}`);
                continue;
            }

            try {
                const webuiDestDir = path.join(destDir, webuiTargetDir);
                copyDirRecursive(webuiDistDir, webuiDestDir);
                logOk(`WebUI (${webuiTargetDir}) 已部署 (${countFiles(webuiDistDir)} 个文件)`);
            } catch (e: any) {
                logErr(`WebUI (${webuiTargetDir}) 部署失败: ${e.message}`);
            }
        }

        // 重载插件
        try {
            const reloaded = await rpc.call('reloadPlugin', pluginName);
            if (reloaded === false) {
                // 插件未注册，走首次加载流程
                throw new Error('not registered');
            }
            logHmr(`${co(pluginName, C.green, C.bold)} 已重载 (${countFiles(distDir)} 个文件)`);
        } catch {
            // 首次加载 — loadDirectoryPlugin 期望插件目录名（非完整路径）
            try {
                await rpc.call('loadDirectoryPlugin', pluginName);
                // 新注册的插件默认禁用，需要手动启用并加载
                try {
                    await rpc.call('setPluginStatus', pluginName, true);
                    await rpc.call('loadPluginById', pluginName);
                } catch { /* 如果已经启用则忽略 */ }
                logOk(`${co(pluginName, C.green, C.bold)} 首次加载成功`);
            } catch (e2: any) {
                logErr(`加载失败: ${e2.message}`);
            }
        }
    }

    /**
     * 仅部署 WebUI（不重新构建后端，独立于 writeBundle）
     */
    async function deployWebuiOnly(): Promise<void> {
        if (!rpc?.connected || !remotePluginPath) {
            logErr('未连接到调试服务，跳过 WebUI 部署');
            return;
        }

        const distDir = path.resolve(config.build.outDir);
        const pkgPath = path.join(distDir, 'package.json');
        if (!fs.existsSync(pkgPath)) {
            logErr('dist/package.json 不存在，跳过 WebUI 部署');
            return;
        }

        let pluginName: string;
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            pluginName = pkg.name;
            if (!pluginName) return;
        } catch {
            return;
        }

        const destDir = path.join(remotePluginPath, pluginName);
        const projectRoot = config.root || process.cwd();

        let hasChanges = false;
        for (const wc of webuiConfigs) {
            const webuiTargetDir = wc.targetDir || 'webui';
            const webuiDistDir = path.resolve(projectRoot, wc.distDir);
            const webuiRoot = wc.root ? path.resolve(projectRoot, wc.root) : path.dirname(webuiDistDir);

            // 执行 WebUI 构建命令
            if (wc.buildCommand) {
                try {
                    log(`构建 WebUI (${co(webuiTargetDir, C.cyan)})...`);
                    execSync(wc.buildCommand, {
                        cwd: webuiRoot,
                        stdio: 'pipe',
                        env: { ...process.env, NODE_ENV: 'production' },
                    });
                    logOk(`WebUI (${webuiTargetDir}) 构建完成`);
                } catch (e: any) {
                    logErr(`WebUI (${webuiTargetDir}) 构建失败: ${e.stderr?.toString() || e.message}`);
                    continue;
                }
            }

            // 复制 WebUI 产物到部署目录
            if (!fs.existsSync(webuiDistDir)) {
                logErr(`WebUI 产物目录不存在: ${webuiDistDir}`);
                continue;
            }

            try {
                const webuiDestDir = path.join(destDir, webuiTargetDir);
                if (fs.existsSync(webuiDestDir)) {
                    fs.rmSync(webuiDestDir, { recursive: true, force: true });
                }
                copyDirRecursive(webuiDistDir, webuiDestDir);
                logOk(`WebUI (${webuiTargetDir}) 已部署 (${countFiles(webuiDistDir)} 个文件)`);
                hasChanges = true;
            } catch (e: any) {
                logErr(`WebUI (${webuiTargetDir}) 部署失败: ${e.message}`);
            }
        }

        // 重载插件
        if (hasChanges) {
            try {
                await rpc.call('reloadPlugin', pluginName);
                logHmr(`${co(pluginName, C.green, C.bold)} 已重载 (WebUI 更新)`);
            } catch (e: any) {
                logErr(`重载失败: ${e.message}`);
            }
        }
    }

    /**
     * 启动 WebUI 源码目录监听
     */
    function startWebuiWatchers(projectRoot: string): void {
        for (const wc of webuiConfigs) {
            if (!wc.watchDir) continue;

            const watchPath = path.resolve(projectRoot, wc.watchDir);
            const webuiTargetDir = wc.targetDir || 'webui';

            if (!fs.existsSync(watchPath)) {
                logErr(`WebUI watchDir 不存在: ${watchPath}`);
                continue;
            }

            try {
                const watcher = fs.watch(watchPath, { recursive: true }, (_event, filename) => {
                    if (!filename) return;
                    // 忽略 node_modules、dist 等目录
                    const normalized = filename.replace(/\\/g, '/');
                    if (
                        normalized.includes('node_modules') ||
                        normalized.includes('/dist/') ||
                        normalized.startsWith('dist/') ||
                        normalized.startsWith('.')
                    ) return;

                    // 防抖：快速连续变化只触发一次
                    if (webuiDeployDebounceTimer) clearTimeout(webuiDeployDebounceTimer);
                    webuiDeployDebounceTimer = setTimeout(() => {
                        log(`WebUI 文件变化: ${co(normalized, C.dim)}`);
                        deployWebuiOnly().catch((e) => logErr(`WebUI 部署出错: ${e.message}`));
                    }, 300);
                });

                webuiWatchers.push(watcher);
                logOk(`监听 WebUI (${webuiTargetDir}): ${co(watchPath, C.dim)}`);
            } catch (e: any) {
                logErr(`无法监听 WebUI 目录: ${e.message}`);
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

            // 首次构建完成后，在 watch 模式下启动 WebUI 文件监听
            if (isFirstBuild && config.build.watch && webuiConfigs.some(wc => wc.watchDir)) {
                const projectRoot = config.root || process.cwd();
                startWebuiWatchers(projectRoot);
            }
            isFirstBuild = false;
        },

        closeBundle() {
            // 清理 WebUI 文件监听
            for (const w of webuiWatchers) {
                try { w.close(); } catch { /* */ }
            }
            webuiWatchers.length = 0;
            if (webuiDeployDebounceTimer) {
                clearTimeout(webuiDeployDebounceTimer);
                webuiDeployDebounceTimer = null;
            }

            // watch 模式下不关闭 WS 连接（Vite 会持续运行）
            if (config.build.watch) return;
            rpc?.close();
            rpc = null;
        },
    };
}

export default napcatHmrPlugin;
