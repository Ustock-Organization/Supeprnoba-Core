// deploy.mjs - AWS SDK를 사용한 Lambda 배포
import { LambdaClient, UpdateFunctionCodeCommand } from '@aws-sdk/client-lambda';
import { readFileSync } from 'fs';

const lambda = new LambdaClient({ region: 'ap-northeast-2' });

async function deploy() {
  console.log('Reading chart-handler.zip...');
  const zipBuffer = readFileSync('./chart-handler.zip');
  
  console.log('Deploying to Supernoba-chart-data-handler...');
  const result = await lambda.send(new UpdateFunctionCodeCommand({
    FunctionName: 'Supernoba-chart-data-handler',
    ZipFile: zipBuffer
  }));
  
  console.log('✅ Deployed successfully!');
  console.log('   FunctionArn:', result.FunctionArn);
  console.log('   LastModified:', result.LastModified);
}

deploy().catch(err => {
  console.error('❌ Deploy failed:', err.message);
  process.exit(1);
});
