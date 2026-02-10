# Supernoba Common Layer 배포 스크립트
# Usage: .\deploy-layer.ps1

$ErrorActionPreference = "Stop"

$LAYER_NAME = "supernoba-common"
$LAYER_DIR = $PSScriptRoot
$NODEJS_DIR = Join-Path $LAYER_DIR "nodejs"
$ZIP_FILE = Join-Path $LAYER_DIR "supernoba-common-layer.zip"
$REGION = "ap-northeast-2"

Write-Host "=== Supernoba Common Layer Deployment ===" -ForegroundColor Cyan

# 1. nodejs 폴더 존재 확인
if (-not (Test-Path $NODEJS_DIR)) {
    Write-Host "ERROR: nodejs/ directory not found at $NODEJS_DIR" -ForegroundColor Red
    exit 1
}

# 2. 기존 zip 파일 삭제
if (Test-Path $ZIP_FILE) {
    Remove-Item $ZIP_FILE -Force
    Write-Host "Removed existing zip file" -ForegroundColor Yellow
}

# 3. nodejs 폴더 압축
Write-Host "Creating zip file..." -ForegroundColor Yellow
Compress-Archive -Path $NODEJS_DIR -DestinationPath $ZIP_FILE -Force
$zipSize = (Get-Item $ZIP_FILE).Length / 1MB
Write-Host "Created: $ZIP_FILE ($([math]::Round($zipSize, 2)) MB)" -ForegroundColor Green

# 4. AWS Lambda Layer 배포
Write-Host "Publishing Lambda Layer..." -ForegroundColor Yellow
$result = aws lambda publish-layer-version `
    --layer-name $LAYER_NAME `
    --description "Supernoba Common Layer - ioredis, secretsManager, corsHeaders, 4-Cache CACHE_PORTS" `
    --zip-file "fileb://$ZIP_FILE" `
    --compatible-runtimes "nodejs18.x" "nodejs20.x" `
    --region $REGION `
    --output json

$resultObj = $result | ConvertFrom-Json
$layerArn = $resultObj.LayerVersionArn
$version = $resultObj.Version

Write-Host ""
Write-Host "Published Layer ARN: $layerArn" -ForegroundColor Green
Write-Host "Version: $version" -ForegroundColor Green
Write-Host "CodeSize: $($resultObj.CodeSize) bytes" -ForegroundColor Gray

# 5. zip 파일 정리
Remove-Item $ZIP_FILE -Force
Write-Host "Cleaned up zip file" -ForegroundColor Gray

# 6. 안내
Write-Host ""
Write-Host "=== Next Steps ===" -ForegroundColor Cyan
Write-Host "Update Lambda functions to use the new layer version:"
Write-Host "  aws lambda update-function-configuration --function-name <FUNCTION_NAME> --layers $layerArn --region $REGION"
Write-Host ""
Write-Host "Or use deploy-all-lambdas.ps1 to redeploy all Lambda functions."
Write-Host ""
Write-Host "Layer deployment completed! (supernoba-common:$version)" -ForegroundColor Green
