/** 插件配置接口 */
export interface DebugPluginConfig {
  port: number;
  host: string;
  enableAuth: boolean;
  authToken: string;
}

/** 序列化的插件信息（WS 传输用） */
export interface RemotePluginInfo {
  id: string;
  fileId: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  pluginPath: string;
  entryPath?: string;
  enable: boolean;
  loaded: boolean;
  runtimeStatus: string;
  runtimeError?: string;
}

/** JSON-RPC 请求 */
export interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown[];
}

/** JSON-RPC 响应 */
export interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; };
}
