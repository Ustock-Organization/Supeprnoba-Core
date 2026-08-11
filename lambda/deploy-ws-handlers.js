// Quick deploy script for Lambda functions
const { execSync } = require('child_process');
const path = require('path');

const REGION = 'ap-northeast-2';

function deploy(funcName, funcPath, hasNodeModules) {
  console.log(`\n=== Deploying ${funcName} ===`);
  
  const fullPath = path.join(__dirname, funcPath);
  process.chdir(fullPath);
  
  // Clean up
  try { execSync('del function.zip', { stdio: 'ignore' }); } catch {}
  
  // Install dependencies if needed
  if (hasNodeModules) {
    console.log('Installing dependencies...');
    execSync('npm ci', { stdio: 'inherit' });
  }
  
  // Create ZIP
  console.log('Creating ZIP...');
  const files = hasNodeModules ? 'index.mjs,package.json,node_modules' : 'index.mjs';
  execSync(`powershell Compress-Archive -Path ${files} -DestinationPath function.zip -Force`, { stdio: 'inherit' });
  
  // Deploy
  console.log('Deploying to Lambda...');
  const result = execSync(
    `aws lambda update-function-code --function-name ${funcName} --zip-file fileb://function.zip --region ${REGION} --query "FunctionArn"`,
    { encoding: 'utf8' }
  );
  console.log('Deployed:', result.trim());
  
  // Clean up
  try { execSync('del function.zip', { stdio: 'ignore' }); } catch {}
  
  console.log(`✅ ${funcName} deployed successfully!`);
}

try {
  deploy('Supernoba-connect-handler', 'Supernoba-connect-handler', true);
  deploy('Supernoba-subscribe-handler', 'Supernoba-subscribe-handler', false);
  deploy('Supernoba-disconnect-handler', 'Supernoba-disconnect-handler', false);
  deploy('Supernoba-admin-ws-handler', 'Supernoba-admin-ws-handler', true);
  deploy('Supernoba-cleanup-handler', 'Supernoba-cleanup-handler', true);
  console.log('\n🎉 All deployments complete!');
} catch (err) {
  console.error('Deployment failed:', err.message);
  process.exit(1);
}
