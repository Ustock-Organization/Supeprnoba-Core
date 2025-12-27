// deploy.mjs - AWS SDK를 사용한 Lambda 배포
import { LambdaClient, UpdateFunctionCodeCommand } from '@aws-sdk/client-lambda';
import { readFileSync } from 'fs';
import { join } from 'path';

const lambda = new LambdaClient({ region: 'ap-northeast-2' });

async function deploy() {
  const zipPath = join(process.cwd(), 'function.zip');
  console.log('Reading', zipPath, '...');
  
  const zipBuffer = readFileSync(zipPath);
  console.log('ZIP file size:', zipBuffer.length, 'bytes');
  
  console.log('Deploying to Supernoba-admin...');
  const result = await lambda.send(new UpdateFunctionCodeCommand({
    FunctionName: 'Supernoba-admin',
    ZipFile: zipBuffer
  }));
  
  console.log('✅ Deployed successfully!');
  console.log('   FunctionArn:', result.FunctionArn);
  console.log('   LastModified:', result.LastModified);
  console.log('   CodeSize:', result.CodeSize, 'bytes');
}

deploy().catch(err => {
  console.error('❌ Deploy failed:', err.message);
  process.exit(1);
});
