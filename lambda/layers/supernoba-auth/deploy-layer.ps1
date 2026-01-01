# Supernoba Auth Layer 배포 스크립트

$ErrorActionPreference = "Stop"

$LAYER_NAME = "supernoba-auth"
$LAYER_DIR = $PSScriptRoot
$NODEJS_DIR = Join-Path $LAYER_DIR "nodejs"
$ZIP_FILE = Join-Path $LAYER_DIR "supernoba-auth-layer.zip"
$REGION = "ap-northeast-2"

Write-Host "=== Supernoba Auth Layer Deployment ===" -ForegroundColor Cyan

# 1. 기존 zip 파일 삭제
if (Test-Path $ZIP_FILE) {
    Remove-Item $ZIP_FILE -Force
    Write-Host "Removed existing zip file" -ForegroundColor Yellow
}

# 2. nodejs 폴더 압축
Write-Host "Creating zip file..." -ForegroundColor Yellow
Compress-Archive -Path $NODEJS_DIR -DestinationPath $ZIP_FILE -Force
Write-Host "Created: $ZIP_FILE" -ForegroundColor Green

# 3. AWS Lambda Layer 배포
Write-Host "Publishing Lambda Layer..." -ForegroundColor Yellow
$result = aws lambda publish-layer-version `
    --layer-name $LAYER_NAME `
    --description "Supernoba Auth Layer - JWT verification for Lambda functions" `
    --zip-file "fileb://$ZIP_FILE" `
    --compatible-runtimes "nodejs18.x" "nodejs20.x" `
    --region $REGION `
    --output json

$layerArn = ($result | ConvertFrom-Json).LayerVersionArn
Write-Host "Published Layer ARN: $layerArn" -ForegroundColor Green

# 4. 환경변수 설정 안내
Write-Host ""
Write-Host "=== Next Steps ===" -ForegroundColor Cyan
Write-Host "1. Add layer to Lambda functions:"
Write-Host "   aws lambda update-function-configuration --function-name <FUNCTION_NAME> --layers $layerArn"
Write-Host ""
Write-Host "2. Add environment variable to Lambda functions:"
Write-Host "   SUPABASE_JWT_SECRET=<your-jwt-secret>"
Write-Host ""
Write-Host "Layer deployment completed!" -ForegroundColor Green
