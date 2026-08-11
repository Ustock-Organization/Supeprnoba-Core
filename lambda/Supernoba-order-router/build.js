import esbuild from 'esbuild';

console.log('Building optimized Lambda bundle...');

esbuild.build({
  entryPoints: ['index.mjs'],
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/index.mjs',
  external: ['@aws-sdk/*'],
  banner: {
    js: 'import{createRequire as ___cr}from"module";const require=___cr(import.meta.url);',
  },
  sourcemap: false,
  treeShaking: true,
}).then(() => {
  console.log('Build complete! Output: dist/index.mjs');
  console.log('Next steps:');
  console.log('1. cd dist');
  console.log('2. zip -j function.zip index.mjs');
  console.log('3. aws lambda update-function-code --function-name Supernoba-order-router --zip-file fileb://function.zip');
}).catch(() => process.exit(1));
