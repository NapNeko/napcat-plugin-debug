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
 * Vite 插件构建配置
 * 产出 cli/vite.mjs，供用户在 vite.config.ts 中 import
 */
export default defineConfig({
    resolve: {
        conditions: ['node', 'default'],
    },
    build: {
        sourcemap: false,
        target: 'esnext',
        minify: false,
        outDir: 'cli',
        emptyOutDir: false,
        lib: {
            entry: resolve(__dirname, 'src/vite-plugin.ts'),
            formats: ['es'],
            fileName: () => 'vite.mjs',
        },
        rollupOptions: {
            // vite 自身作为 peerDep，不打包进去
            external: [...nodeModules, 'vite', 'ws'],
            output: {
                inlineDynamicImports: true,
            },
        },
    },
    plugins: [nodeResolve()],
});
