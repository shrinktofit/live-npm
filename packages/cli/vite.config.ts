import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

const externals = [
  ...builtinModules,
  /^node:/,
  '@npmcli/arborist',
  'chalk',
  'chokidar',
  'npm-packlist',
  'yaml',
  /^yargs(\/.*)?$/,
];

export default defineConfig({
  build: {
    outDir: './lib',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    lib: {
      entry: {
        cli: './src/cli.ts',
        index: './src/index.ts',
      },
      formats: ['es'],
      fileName: (_, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: externals,
    },
  },
});
