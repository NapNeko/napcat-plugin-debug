import { resolve, dirname } from 'path';
import { defineConfig } from 'vite';
import nodeResolve from '@rollup/plugin-node-resolve';
import { builtinModules } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const nodeModules = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
].flat();

// 依赖排除
const external: string[] = [];

/**
 * 构建后生成精简 package.json 的 Vite 插件
 */
function copyAssetsPlugin () {
  return {
    name: 'copy-assets',
    writeBundle () {
      try {
        const distDir = resolve(__dirname, 'dist');

        // 生成精简的 package.json
        const pkgPath = resolve(__dirname, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          const distPkg = {
            name: pkg.name,
            plugin: pkg.plugin,
            version: pkg.version,
            type: pkg.type,
            main: pkg.main,
            description: pkg.description,
            author: pkg.author,
            napcat: pkg.napcat,
            dependencies: pkg.dependencies,
          };
          fs.writeFileSync(
            resolve(distDir, 'package.json'),
            JSON.stringify(distPkg, null, 2)
          );
          console.log('[copy-assets] ✅ 已生成精简 package.json');
        }

        console.log('[copy-assets] 🎉 构建完成！将 dist/ 目录复制到 NapCat 的 plugins/ 即可');
      } catch (error) {
        console.error('[copy-assets] ❌ 资源复制失败:', error);
      }
    },
  };
}

export default defineConfig({
  resolve: {
    conditions: ['node', 'default'],
  },
  build: {
    sourcemap: false,
    target: 'esnext',
    minify: false,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
    rollupOptions: {
      external: [...nodeModules, ...external],
      output: {
        inlineDynamicImports: true,
      },
    },
    outDir: 'dist',
  },
  plugins: [nodeResolve(), copyAssetsPlugin()],
});
