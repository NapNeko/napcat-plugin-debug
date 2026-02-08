# napcat-plugin-debug

NapCat 插件调试服务 -- 通过 WebSocket 暴露 PluginManager API，配合 Vite 插件或 CLI 工具实现插件热重载开发。

## 架构

```
NapCat
  └─ napcat-plugin-debug (本插件)
       └─ WebSocket Server (:8998)
            └─ JSON-RPC 2.0 协议
                 ├─ napcatHmrPlugin (Vite 插件，自动部署+重载)
                 └─ napcat-debug CLI (交互式 REPL)
```

本仓库包含三个组件：

| 组件 | 输出 | 说明 |
|------|------|------|
| NapCat 端插件 | `dist/index.mjs` | 在 NapCat 中运行，启动 WebSocket 调试服务器 |
| CLI 工具 | `cli/cli.mjs` | 独立命令行工具，提供 REPL 交互、手动部署、文件监听 |
| Vite 插件 | `cli/vite.mjs` | 集成到 Vite 构建流程，`writeBundle` 时自动部署+重载 |

CLI 和 Vite 插件以 `napcat-plugin-debug-cli` 包名发布到 npm。

## 安装

### NapCat 端

在 NapCat 插件市场中搜索并安装 `napcat-plugin-debug`（插件调试服务），启用后自动在 `ws://127.0.0.1:8998` 启动 WebSocket 调试服务。

### 插件开发端

在你的插件项目中安装 CLI 和 ws 作为开发依赖：

```bash
pnpm add -D napcat-plugin-debug-cli ws
```

> 如果使用 [napcat-plugin-template](https://github.com/NapNeko/napcat-plugin-template)，这些依赖和配置已经预置好。

## 安全注意事项

调试服务基于 WebSocket 通信，**默认不启用认证（无 token）**，任何能访问该端口的客户端均可执行插件管理操作（加载、卸载、重载插件等）。

- **强烈建议在本地环境调试**（默认监听 `127.0.0.1`），避免远程调试
- **未配置 token 时，切勿将调试端口暴露在公网中**，否则任何人都可以连接并操控你的 NapCat 插件
- 如果确实需要远程调试，**必须同时启用认证并设置高强度 token**，且通过防火墙严格限制来源 IP
- 推荐使用 SSH 隧道转发端口（如 `ssh -L 8998:127.0.0.1:8998 user@server`），而非直接开放端口
- **生产环境不要启用调试插件**，仅在开发阶段使用

## 配置项

在 NapCat WebUI 的插件配置中修改：

| 配置项 | 默认值 | 说明 |
|-------|--------|------|
| 调试服务端口 | `8998` | WebSocket 监听端口 |
| 监听地址 | `127.0.0.1` | 请勿改为 `0.0.0.0`，除非你清楚安全风险 |
| 启用认证 | `false` | 启用后客户端需提供 token 才能连接 |
| 认证 Token | 空 | 客户端连接时的认证凭据，请使用高强度随机字符串 |

## 使用方式

### 一、Vite 插件（推荐）

在 `vite.config.ts` 中引入 `napcatHmrPlugin`：

```typescript
import { napcatHmrPlugin } from 'napcat-plugin-debug-cli/vite'

export default defineConfig({
  plugins: [
    napcatHmrPlugin(),  // 构建完成后自动部署+重载
  ],
})
```

可选配置：

```typescript
napcatHmrPlugin({
  wsUrl: 'ws://127.0.0.1:8998',  // 调试服务地址（默认值）
  token: 'mySecret',              // 认证 token
  enabled: true,                   // 是否启用（默认 true）
})
```

配合 npm scripts 使用：

```bash
# 一键部署：构建 → 自动复制到远程插件目录 → 自动重载
pnpm run push

# 开发模式：watch 构建 + 每次构建后自动部署 + 热重载
pnpm run dev
```

Vite 插件在每次 `writeBundle` 时自动完成：连接调试服务 -> 获取远程插件目录 -> 复制 dist/ -> 调用 reloadPlugin。

### 二、CLI 交互模式

```bash
npx napcat-debug [ws-url] [options]
```

| 参数 | 说明 |
|-----|------|
| `ws://host:port` | 调试服务地址（默认 `ws://127.0.0.1:8998`） |
| `-t, --token <token>` | 认证 token |
| `-w, --watch <dir>` | 监听目录，文件变更时自动热重载 |
| `-W, --watch-all` | 监听远程插件目录下的所有插件 |
| `-d, --deploy [dir]` | 部署插件 dist/ 到远程并重载（默认当前目录） |
| `-v, --verbose` | 详细输出（显示事件通知等） |

REPL 交互命令：

| 命令 | 说明 |
|------|------|
| `list` | 列出所有插件及其加载状态 |
| `reload <id>` | 重载指定插件 |
| `load <id>` | 加载指定插件 |
| `unload <id>` | 卸载指定插件 |
| `info <id>` | 查看插件详细信息 |
| `deploy [dir]` | 部署插件到远程并重载 |
| `watch <dir>` | 开始监听目录 |
| `unwatch` | 停止监听 |
| `status` | 查看调试服务状态 |
| `ping` | 心跳测试 |
| `quit` | 退出 |

### 常用组合

```bash
# 默认连接本地，进入 REPL
napcat-debug

# 带认证连接
napcat-debug --token mySecret

# 构建后一键部署
napcat-debug --deploy .

# 监听 dist/ 目录自动热重载
napcat-debug --watch ./dist
```

## JSON-RPC 方法

调试服务暴露以下 RPC 方法：

| 方法 | 参数 | 说明 |
|------|------|------|
| `ping` | - | 心跳测试，返回 `"pong"` |
| `getDebugInfo` | - | 获取调试服务信息（版本、插件数、插件目录、运行时间） |
| `getPluginPath` | - | 获取插件目录路径 |
| `getAllPlugins` | - | 列出所有插件信息 |
| `getLoadedPlugins` | - | 列出已加载的插件 |
| `getPluginInfo` | `[id]` | 获取指定插件详情 |
| `setPluginStatus` | `[id, enabled]` | 设置插件启用/禁用 |
| `loadPluginById` | `[id]` | 加载指定插件 |
| `unregisterPlugin` | `[id]` | 注销插件 |
| `reloadPlugin` | `[id]` | 重载插件（热重载核心方法） |
| `scanPlugins` | - | 扫描插件目录 |
| `loadDirectoryPlugin` | `[dirname]` | 从指定目录名加载插件（相对于插件根目录的目录名，非完整路径） |
| `uninstallPlugin` | `[id, removeData]` | 卸载插件 |
| `getPluginDataPath` | `[id]` | 获取插件数据目录 |
| `getPluginConfigPath` | `[id]` | 获取插件配置路径 |
| `getPluginConfig` | - | 获取插件管理器配置 |

## 开发

```bash
# 安装依赖
pnpm install

# 完整构建（插件 + CLI + Vite 插件）
pnpm run build

# 仅构建 NapCat 端插件
pnpm run build:plugin

# 仅构建 CLI + Vite 插件
pnpm run build:cli

# 监听模式构建插件
pnpm run watch

# 类型检查
pnpm run typecheck

# 发布 CLI 到 npm
pnpm run publish:cli
```

### 构建产物

```
dist/
  └── index.mjs          # NapCat 端插件入口

cli/
  ├── cli.mjs            # CLI 可执行文件
  ├── vite.mjs           # Vite 插件导出
  └── package.json       # napcat-plugin-debug-cli 包描述
```

## 许可

MIT
