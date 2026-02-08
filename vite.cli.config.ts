import { resolve, dirname } from 'path';
import { defineConfig } from 'vite';
import nodeResolve from '@rollup/plugin-node-resolve';
import { builtinModules } from 'module';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const nodeModules = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
].flat();

/**
 * CLI 构建配置
 * 将 ws 打包进去，产出单文件 dist/cli.mjs，可直接 node 运行
 */
export default defineConfig({
  resolve: {
    conditions: ['node', 'default'],
  },
  build: {
    sourcemap: false,
    target: 'esnext',
    minify: false,
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/cli.ts'),
      formats: ['es'],
      fileName: () => 'cli.mjs',
    },
    rollupOptions: {
      external: nodeModules,
      output: {
        banner: '#!/usr/bin/env node',
        inlineDynamicImports: true,
      },
    },
  },
  plugins: [nodeResolve()],
});
