# Lambda Functions Deployment Script
# Usage: .\deploy-all-lambdas.ps1
# This script should be placed in liquibook/lambda/ directory

$ErrorActionPreference = "Stop"

# Get script directory (should be liquibook/lambda/)
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$LAMBDA_DIR = $SCRIPT_DIR
$REGION = "ap-northeast-2"

# Lambda functions to deploy
$LAMBDA_FUNCTIONS = @(
    @{ Name = "Supernoba-admin"; Path = "Supernoba-admin"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-order-router"; Path = "Supernoba-order-router"; HasPackageJson = $true; HasBuild = $true },
    @{ Name = "Supernoba-asset-handler"; Path = "Supernoba-asset-handler"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-fill-processor"; Path = "Supernoba-fill-processor"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-history-saver"; Path = "Supernoba-history-saver"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-notifier"; Path = "Supernoba-notifier"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-chart-data-handler"; Path = "Supernoba-chart-data-handler"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-connect-handler"; Path = "Supernoba-connect-handler"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-subscribe-handler"; Path = "Supernoba-subscribe-handler"; HasPackageJson = $false; HasBuild = $false },
    @{ Name = "Supernoba-disconnect-handler"; Path = "Supernoba-disconnect-handler"; HasPackageJson = $false; HasBuild = $false }
)

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Starting Lambda Functions Deployment" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

$deployed = 0
$failed = 0

foreach ($func in $LAMBDA_FUNCTIONS) {
    $funcPath = Join-Path $LAMBDA_DIR $func.Path
    
    Write-Host "----------------------------------------" -ForegroundColor Yellow
    Write-Host "[$($func.Name)] Starting deployment..." -ForegroundColor Yellow
    Write-Host "Path: $funcPath" -ForegroundColor Gray
    
    try {
        $originalLocation = Get-Location
        Set-Location $funcPath
        
        # Remove existing ZIP file
        if (Test-Path "function.zip") {
            Remove-Item "function.zip" -Force
            Write-Host "Removed existing ZIP file" -ForegroundColor Gray
        }
        
        # Install dependencies
        if ($func.HasPackageJson) {
            Write-Host "Installing dependencies..." -ForegroundColor Gray
            npm ci
            if ($LASTEXITCODE -ne 0) {
                throw "npm ci failed"
            }
        }
        
        # Build (esbuild etc)
        if ($func.HasBuild) {
            Write-Host "Building..." -ForegroundColor Gray
            if (Test-Path "build.cjs") {
                node build.cjs
            } elseif (Test-Path "build.js") {
                node build.js
            }
            if ($LASTEXITCODE -ne 0) {
                throw "Build failed"
            }
        }
        
        # Create ZIP file
        Write-Host "Creating ZIP file..." -ForegroundColor Gray
        
        if (Test-Path "dist") {
            # esbuild build output
            Set-Location dist
            Compress-Archive -Path "index.js" -DestinationPath "..\function.zip" -Force -CompressionLevel Fastest
            Set-Location ..
        }
        elseif ($func.HasPackageJson) {
            # Regular Node.js Lambda with dependencies
            # Use absolute path for ZIP file
            $zipFile = Join-Path (Get-Location) "function.zip"
            Compress-Archive -Path "index.mjs", "package.json", "node_modules" -DestinationPath $zipFile -Force -CompressionLevel Fastest
        }
        else {
            # No package.json (no dependencies)
            Compress-Archive -Path "index.mjs" -DestinationPath "function.zip" -Force -CompressionLevel Fastest
        }
        
        $zipSize = (Get-Item "function.zip").Length / 1MB
        Write-Host "ZIP file size: $([math]::Round($zipSize, 2)) MB" -ForegroundColor Gray
        
        # Upload to AWS Lambda
        Write-Host "Uploading to AWS Lambda..." -ForegroundColor Gray
        $deployResult = aws lambda update-function-code `
            --function-name $func.Name `
            --zip-file "fileb://function.zip" `
            --region $REGION `
            --output json
        
        if ($LASTEXITCODE -ne 0) {
            throw "Lambda upload failed"
        }
        
        $resultObj = $deployResult | ConvertFrom-Json
        Write-Host "SUCCESS!" -ForegroundColor Green
        Write-Host "  FunctionArn: $($resultObj.FunctionArn)" -ForegroundColor Gray
        Write-Host "  LastModified: $($resultObj.LastModified)" -ForegroundColor Gray
        Write-Host "  CodeSize: $($resultObj.CodeSize) bytes" -ForegroundColor Gray
        
        # Clean up build artifacts
        Write-Host "Cleaning up build artifacts..." -ForegroundColor Gray
        if (Test-Path "function.zip") {
            Remove-Item "function.zip" -Force
        }
        if (Test-Path "dist") {
            Remove-Item "dist" -Recurse -Force
        }
        if (Test-Path "node_modules") {
            Remove-Item "node_modules" -Recurse -Force
        }
        if (Test-Path "package-lock.json") {
            Remove-Item "package-lock.json" -Force
        }
        
        $deployed++
        
    }
    catch {
        Write-Host "FAILED: $_" -ForegroundColor Red
        $failed++
    }
    finally {
        Set-Location $originalLocation
    }
    
    Write-Host ""
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Deployment Complete" -ForegroundColor Cyan
Write-Host "Success: $deployed" -ForegroundColor Green
Write-Host "Failed: $failed" -ForegroundColor $(if ($failed -eq 0) { "Green" } else { "Red" })
Write-Host "==========================================" -ForegroundColor Cyan

if ($failed -gt 0) {
    exit 1
}

