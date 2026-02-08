#!/usr/bin/env node
/**
 * napcat-plugin-debug CLI
 *
 * 连接 NapCat 调试服务，提供插件管理和热重载。
 * 纯 Node.js 实现，无外部依赖（使用内置 WebSocket 客户端）。
 *
 * 用法：
 *   node cli.mjs                                  # 默认连接 ws://127.0.0.1:8998
 *   node cli.mjs ws://192.168.1.100:8998           # 指定地址
 *   node cli.mjs --token mySecret                  # 带认证
 *   node cli.mjs --watch ./my-plugin               # 监听目录自动热重载
 *   node cli.mjs --watch-all                       # 监听所有插件
 */

import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// ======================== 类型 ========================

interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown[];
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: { code: number; message: string; };
}

interface RemotePluginInfo {
  id: string;
  fileId: string;
  name?: string;
  version?: string;
  enable: boolean;
  loaded: boolean;
  runtimeStatus: string;
  runtimeError?: string;
}

// ======================== 参数解析 ========================

interface CliOptions {
  wsUrl: string;
  token?: string;
  watch?: string;
  watchAll: boolean;
  verbose: boolean;
}

function parseArgs (): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = { wsUrl: 'ws://127.0.0.1:8998', watchAll: false, verbose: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
    else if (arg === '--token' || arg === '-t') { opts.token = args[++i]; }
    else if (arg === '--watch' || arg === '-w') { opts.watch = args[++i]; }
    else if (arg === '--watch-all' || arg === '-W') { opts.watchAll = true; }
    else if (arg === '--verbose' || arg === '-v') { opts.verbose = true; }
    else if (arg.startsWith('ws://') || arg.startsWith('wss://')) { opts.wsUrl = arg; }
  }
  return opts;
}

function printHelp (): void {
  console.log(`
napcat-plugin-debug CLI — NapCat 插件调试 & 热重载

用法：node cli.mjs [ws-url] [options]

选项：
  ws://host:port       调试服务地址 (默认: ws://127.0.0.1:8998)
  -t, --token <token>  认证 token
  -w, --watch <dir>    监听目录自动热重载
  -W, --watch-all      监听远程插件目录所有插件
  -v, --verbose        详细输出
  -h, --help           帮助

交互命令：
  list                 列出所有插件
  reload <id>          重载插件
  load <id>            加载插件
  unload <id>          卸载插件
  info <id>            插件详情
  watch <dir>          开始监听
  unwatch              停止监听
  status               服务状态
  ping                 心跳
  quit                 退出
`);
}

// ======================== 颜色输出 ========================

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

const co = (t: string, ...c: string[]) => c.join('') + t + C.reset;
const now = () => co(new Date().toLocaleTimeString('en-US', { hour12: false }), C.gray);

const logInfo = (m: string) => console.log(`${now()} ${co('ℹ', C.blue)} ${m}`);
const logOk = (m: string) => console.log(`${now()} ${co('✓', C.green)} ${m}`);
const logWarn = (m: string) => console.log(`${now()} ${co('⚠', C.yellow)} ${m}`);
const logErr = (m: string) => console.log(`${now()} ${co('✗', C.red)} ${m}`);
const logHmr = (m: string) => console.log(`${now()} ${co('🔥', C.magenta)} ${co(m, C.magenta)}`);

// ======================== JSON-RPC 客户端 ========================

class RpcClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; }>();

  constructor (ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw: Buffer) => {
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
      } catch { /* */ }
    });
  }

  call (method: string, ...params: unknown[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const req: RpcRequest = { jsonrpc: '2.0', id, method, params };
      this.ws.send(JSON.stringify(req));
      // 10s 超时
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('RPC timeout'));
        }
      }, 10000);
    });
  }
}

// ======================== 文件监听 ========================

function createWatcher (
  watchPath: string,
  onPluginChange: (dirName: string, filePath: string) => void,
) {
  const watchers = new Map<string, fs.FSWatcher>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let active = false;
  const EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.json']);

  function watchDir (name: string, dirPath: string) {
    try {
      const w = fs.watch(dirPath, { recursive: true, persistent: false }, (_ev, file) => {
        if (!file) return;
        if (!EXTS.has(path.extname(file))) return;
        if (file.includes('node_modules') || file.startsWith('.')) return;
        const t = timers.get(name);
        if (t) clearTimeout(t);
        timers.set(name, setTimeout(() => {
          timers.delete(name);
          onPluginChange(name, path.join(dirPath, file));
        }, 500));
      });
      watchers.set(name, w);
    } catch (e) { logWarn(`监听 ${name} 失败: ${e}`); }
  }

  return {
    get isActive () { return active; },
    get path () { return watchPath; },
    start () {
      if (active) return;
      if (!fs.existsSync(watchPath)) { logErr(`目录不存在: ${watchPath}`); return; }
      active = true;

      if (fs.existsSync(path.join(watchPath, 'package.json'))) {
        // 单个插件
        watchDir(path.basename(watchPath), watchPath);
        logHmr(`监听插件: ${path.basename(watchPath)}`);
      } else {
        // 整个插件目录
        for (const d of fs.readdirSync(watchPath, { withFileTypes: true })) {
          if (d.isDirectory()) watchDir(d.name, path.join(watchPath, d.name));
        }
        logHmr(`监听 ${watchers.size} 个插件: ${watchPath}`);
      }
    },
    stop () {
      if (!active) return;
      active = false;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const [, w] of watchers) try { w.close(); } catch { /* */ }
      watchers.clear();
      logInfo('文件监听已停止');
    },
  };
}

// ======================== 主逻辑 ========================

async function main () {
  const opts = parseArgs();

  console.log(co('\n  napcat-plugin-debug CLI', C.bold, C.cyan));
  console.log(co('  NapCat 插件调试 & 热重载\n', C.dim));

  let wsUrl = opts.wsUrl;
  if (opts.token) {
    const u = new URL(wsUrl);
    u.searchParams.set('token', opts.token);
    wsUrl = u.toString();
  }

  logInfo(`连接 ${co(opts.wsUrl, C.cyan)}...`);

  const ws = new WebSocket(wsUrl);
  let rpc: RpcClient | null = null;
  let watcher: ReturnType<typeof createWatcher> | null = null;
  let remotePluginPath: string | null = null;
  const dirToId = new Map<string, string>();

  async function refreshMap () {
    if (!rpc) return;
    try {
      const plugins: RemotePluginInfo[] = await rpc.call('getAllPlugins');
      dirToId.clear();
      for (const p of plugins) dirToId.set(p.fileId, p.id);
    } catch { /* */ }
  }

  async function onFileChange (dirName: string, filePath: string) {
    if (!rpc) return;
    await refreshMap();
    const id = dirToId.get(dirName) ?? dirName;
    logHmr(`变更检测: ${co(id, C.bold)} (${path.basename(filePath)})`);
    try {
      const ok = await rpc.call('reloadPlugin', id);
      ok ? logOk(`${co(id, C.green, C.bold)} 重载成功`) : logWarn(`${id} 重载返回 false`);
    } catch (e: any) { logErr(`重载 ${id} 失败: ${e.message}`); }
  }

  ws.on('open', () => logOk('已连接'));

  ws.on('message', async (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      // 欢迎消息
      if (msg.method === 'welcome') {
        logOk(`服务器 v${msg.params.version}, ${msg.params.pluginCount} 个插件`);
        rpc = new RpcClient(ws);

        try {
          const info = await rpc.call('getDebugInfo');
          remotePluginPath = info.pluginPath;
          logInfo(`远程插件目录: ${co(info.pluginPath, C.dim)}`);
          logInfo(`插件: ${info.loadedCount}/${info.pluginCount} 已加载`);
        } catch (e: any) { logWarn(`获取信息失败: ${e.message}`); }

        // 启动文件监听
        if (opts.watch) {
          watcher = createWatcher(path.resolve(opts.watch), onFileChange);
          watcher.start();
        } else if (opts.watchAll && remotePluginPath) {
          watcher = createWatcher(remotePluginPath, onFileChange);
          watcher.start();
        }

        startRepl(rpc, watcher, remotePluginPath, onFileChange);
      }
      // 事件通知
      if (msg.method === 'event' && opts.verbose) {
        logInfo(`事件: ${JSON.stringify(msg.params).substring(0, 100)}`);
      }
    } catch { /* */ }
  });

  ws.on('close', (code: number) => {
    logWarn(`断开连接 (${code})`);
    watcher?.stop();
    process.exit(code === 1000 ? 0 : 1);
  });

  ws.on('error', (e: Error) => logErr(`连接错误: ${e.message}`));

  process.on('SIGINT', () => {
    console.log('');
    watcher?.stop();
    ws.close(1000);
    process.exit(0);
  });
}

// ======================== REPL 交互 ========================

function startRepl (
  rpc: RpcClient,
  watcher: ReturnType<typeof createWatcher> | null,
  remotePath: string | null,
  onFileChange: (d: string, f: string) => Promise<void>,
) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: co('debug> ', C.cyan) });
  rl.prompt();

  rl.on('line', async (line) => {
    const [cmd, ...args] = line.trim().split(/\s+/);
    if (!cmd) { rl.prompt(); return; }

    try {
      switch (cmd) {
        case 'list': case 'ls': {
          const plugins: RemotePluginInfo[] = await rpc.call('getAllPlugins');
          if (!plugins.length) { logInfo('无插件'); break; }
          console.log(`\n  ${co('ID', C.bold).padEnd(42)}${co('版本', C.bold).padEnd(14)}${co('状态', C.bold)}`);
          console.log('  ' + '─'.repeat(56));
          for (const p of plugins) {
            const id = (p.id || p.fileId).padEnd(32);
            const ver = (p.version || '-').padEnd(10);
            const st = p.loaded ? co('● 已加载', C.green)
              : p.enable ? co('○ 已启用', C.yellow)
                : co('○ 已禁用', C.dim);
            console.log(`  ${id}${ver}${st}`);
          }
          console.log('');
          break;
        }
        case 'reload': {
          if (!args[0]) { logErr('用法: reload <id>'); break; }
          logInfo(`重载 ${args[0]}...`);
          const ok = await rpc.call('reloadPlugin', args[0]);
          ok ? logOk('重载成功') : logWarn('重载返回 false');
          break;
        }
        case 'load': {
          if (!args[0]) { logErr('用法: load <id>'); break; }
          const ok = await rpc.call('loadPluginById', args[0]);
          ok ? logOk('加载成功') : logWarn('加载返回 false');
          break;
        }
        case 'unload': {
          if (!args[0]) { logErr('用法: unload <id>'); break; }
          await rpc.call('unregisterPlugin', args[0]);
          logOk('已卸载');
          break;
        }
        case 'info': {
          if (!args[0]) { logErr('用法: info <id>'); break; }
          const i = await rpc.call('getPluginInfo', args[0]);
          if (!i) { logErr('插件不存在'); break; }
          console.log(`\n  ID:      ${i.id}\n  名称:    ${i.name || '-'}\n  版本:    ${i.version || '-'}\n  路径:    ${i.pluginPath}\n  启用:    ${i.enable}\n  已加载:  ${i.loaded}\n  状态:    ${i.runtimeStatus}\n`);
          break;
        }
        case 'watch': {
          if (!args[0]) { logErr('用法: watch <dir>'); break; }
          watcher?.stop();
          watcher = createWatcher(path.resolve(args[0]), onFileChange);
          watcher.start();
          break;
        }
        case 'unwatch': {
          watcher?.stop(); watcher = null; logOk('已停止监听');
          break;
        }
        case 'status': {
          const s = await rpc.call('getDebugInfo');
          console.log(`\n  服务:    v${s.version}\n  插件:    ${s.loadedCount}/${s.pluginCount} 已加载\n  目录:    ${s.pluginPath}\n  运行:    ${Math.floor(s.uptime)}s\n  HMR:     ${watcher?.isActive ? co('活跃', C.green) + ` (${watcher.path})` : co('未启动', C.dim)}\n`);
          break;
        }
        case 'ping': {
          const t = Date.now();
          const r = await rpc.call('ping');
          logOk(`${r} (${Date.now() - t}ms)`);
          break;
        }
        case 'help': printHelp(); break;
        case 'quit': case 'exit': case 'q': process.exit(0);
        default: logWarn(`未知命令: ${cmd}，输入 help 查看`);
      }
    } catch (e: any) { logErr(`命令失败: ${e.message}`); }
    rl.prompt();
  });
}

// ======================== 入口 ========================

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
