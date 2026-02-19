import esbuild from 'esbuild';

console.log('Building optimized Lambda bundle...');

esbuild.build({
  entryPoints: ['index.mjs'],
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.mjs',
  // createRequire 배너: ESM 번들 내 CJS 의존성의 require() 호출을 지원
  // AWS SDK v3 등 CJS 모듈이 require('buffer') 등을 사용하므로 필수
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
