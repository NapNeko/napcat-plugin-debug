import fs from 'node:fs';
import path from 'node:path';

const C = {
  reset: "\x1B[0m",
  bold: "\x1B[1m",
  dim: "\x1B[2m",
  red: "\x1B[31m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  blue: "\x1B[34m",
  magenta: "\x1B[35m",
  cyan: "\x1B[36m",
  gray: "\x1B[90m"
};
const co = (t, ...c) => c.join("") + t + C.reset;
const PREFIX = co("[napcat-hmr]", C.magenta, C.bold);
const log = (m) => console.log(`${PREFIX} ${m}`);
const logOk = (m) => console.log(`${PREFIX} ${co("(o'v'o)", C.green)} ${m}`);
const logErr = (m) => console.log(`${PREFIX} ${co("(;_;)", C.red)} ${m}`);
const logHmr = (m) => console.log(`${PREFIX} ${co("(&gt;&lt;)", C.yellow)} ${co(m, C.magenta)}`);
class SimpleRpcClient {
  ws;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  constructor(ws) {
    this.ws = ws;
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.jsonrpc === "2.0" && msg.id != null) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        }
      } catch {
      }
    });
  }
  call(method, ...params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const req = { jsonrpc: "2.0", id, method, params };
      this.ws.send(JSON.stringify(req));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("RPC timeout"));
        }
      }, 1e4);
    });
  }
  get connected() {
    return this.ws?.readyState === 1;
  }
  close() {
    try {
      this.ws?.close(1e3);
    } catch {
    }
  }
}
function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}
function countFiles(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
    else count++;
  }
  return count;
}
function napcatHmrPlugin(options = {}) {
  const {
    wsUrl = "ws://127.0.0.1:8998",
    token,
    enabled = true,
    autoConnect = true
  } = options;
  let rpc = null;
  let remotePluginPath = null;
  let connecting = false;
  let config;
  let isFirstBuild = true;
  async function connect() {
    if (rpc?.connected) return true;
    if (connecting) return false;
    connecting = true;
    try {
      process.env.WS_NO_BUFFER_UTIL = "1";
      process.env.WS_NO_UTF_8_VALIDATE = "1";
      const { default: WebSocket } = await import('ws');
      let url = wsUrl;
      if (token) {
        const u = new URL(url);
        u.searchParams.set("token", token);
        url = u.toString();
      }
      return await new Promise((resolve) => {
        const ws = new WebSocket(url);
        const timeout = setTimeout(() => {
          ws.close();
          connecting = false;
          resolve(false);
        }, 5e3);
        ws.on("open", () => {
          clearTimeout(timeout);
        });
        ws.on("message", async (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.method === "welcome") {
              rpc = new SimpleRpcClient(ws);
              try {
                const info = await rpc.call("getDebugInfo");
                remotePluginPath = info.pluginPath;
                logOk(`已连接调试服务 (${info.loadedCount}/${info.pluginCount} 插件)`);
                log(`远程插件目录: ${co(info.pluginPath, C.dim)}`);
              } catch {
              }
              connecting = false;
              resolve(true);
            }
          } catch {
          }
        });
        ws.on("error", () => {
          clearTimeout(timeout);
          connecting = false;
          resolve(false);
        });
        ws.on("close", () => {
          rpc = null;
          remotePluginPath = null;
          connecting = false;
        });
      });
    } catch (e) {
      connecting = false;
      return false;
    }
  }
  async function deployAndReload(distDir) {
    if (!rpc?.connected || !remotePluginPath) {
      logErr("未连接到调试服务，跳过部署");
      return;
    }
    const pkgPath = path.join(distDir, "package.json");
    if (!fs.existsSync(pkgPath)) {
      logErr("dist/package.json 不存在，跳过部署");
      return;
    }
    let pluginName;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      pluginName = pkg.name;
      if (!pluginName) {
        logErr("dist/package.json 中缺少 name 字段");
        return;
      }
    } catch {
      logErr("解析 dist/package.json 失败");
      return;
    }
    const destDir = path.join(remotePluginPath, pluginName);
    try {
      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true });
      }
      copyDirRecursive(distDir, destDir);
    } catch (e) {
      logErr(`复制文件失败: ${e.message}`);
      return;
    }
    try {
      const reloaded = await rpc.call("reloadPlugin", pluginName);
      if (reloaded === false) {
        throw new Error("not registered");
      }
      logHmr(`${co(pluginName, C.green, C.bold)} 已重载 (${countFiles(distDir)} 个文件)`);
    } catch {
      try {
        await rpc.call("loadDirectoryPlugin", destDir);
        try {
          await rpc.call("setPluginStatus", pluginName, true);
          await rpc.call("loadPluginById", pluginName);
        } catch {
        }
        logOk(`${co(pluginName, C.green, C.bold)} 首次加载成功`);
      } catch (e2) {
        logErr(`加载失败: ${e2.message}`);
      }
    }
  }
  return {
    name: "napcat-hmr",
    apply: "build",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    async buildStart() {
      if (!enabled) return;
      if (!autoConnect) return;
      if (isFirstBuild) {
        log(`连接 ${co(wsUrl, C.cyan)}...`);
        const ok = await connect();
        if (!ok) {
          logErr(`无法连接调试服务 ${wsUrl}`);
          log("请确认 napcat-plugin-debug 已启用");
          log("仅构建模式，不自动部署");
        }
      }
    },
    async writeBundle() {
      if (!enabled) return;
      const distDir = path.resolve(config.build.outDir);
      if (!rpc?.connected) {
        const ok = await connect();
        if (!ok) return;
      }
      await deployAndReload(distDir);
      isFirstBuild = false;
    },
    closeBundle() {
      if (config.build.watch) return;
      rpc?.close();
      rpc = null;
    }
  };
}

export { napcatHmrPlugin as default, napcatHmrPlugin };
