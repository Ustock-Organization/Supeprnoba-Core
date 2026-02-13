# Lambda Functions Deployment Script
# Usage: .\deploy-all-lambdas.ps1
# This script should be placed in liquibook/lambda/ directory

$ErrorActionPreference = "Stop"

# Get script directory (should be liquibook/lambda/)
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$LAMBDA_DIR = $SCRIPT_DIR
$REGION = "ap-northeast-2"

# Lambda functions to deploy
# NOTE: 아래 4개 Lambda는 stock-processor (C++)로 이전됨 - 2026-01-12
#   - Supernoba-fill-processor → Supernoba-back/src/processors/fill_processor.cpp
#   - Supernoba-history-saver → Supernoba-back/src/processors/history_processor.cpp
#   - Supernoba-notifier → Supernoba-back/src/processors/notification_processor.cpp
#   - Supernoba-order-status-processor → Supernoba-back/src/processors/order_status_processor.cpp
$LAMBDA_FUNCTIONS = @(
    # === REST API ===
    @{ Name = "Supernoba-admin"; Path = "Supernoba-admin"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-admin-core"; Path = "Supernoba-admin-core"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-admin-stats"; Path = "Supernoba-admin-stats"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-admin-monitoring"; Path = "Supernoba-admin-monitoring"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-admin-users"; Path = "Supernoba-admin-users"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-admin-mm"; Path = "Supernoba-admin-mm"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-symbol-admin"; Path = "Supernoba-symbol-admin"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-order-router"; Path = "Supernoba-order-router"; HasPackageJson = $true; HasBuild = $true },
    @{ Name = "Supernoba-asset-handler"; Path = "Supernoba-asset-handler"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-chart-data-handler"; Path = "Supernoba-chart-data-handler"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-history"; Path = "Supernoba-history"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-rankings"; Path = "Supernoba-rankings"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-treemap-data"; Path = "Supernoba-treemap-data"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-announcements"; Path = "Supernoba-announcements"; HasPackageJson = $false; HasBuild = $false },
    @{ Name = "Supernoba-approval-handler"; Path = "Supernoba-approval-handler"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-preview-handler"; Path = "Supernoba-preview-handler"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-favorites"; Path = "Supernoba-favorites"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-creator-requests"; Path = "Supernoba-creator-requests"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-push-tokens"; Path = "Supernoba-push-tokens"; HasPackageJson = $true; HasBuild = $false },

    # === WebSocket ===
    @{ Name = "Supernoba-connect-handler"; Path = "Supernoba-connect-handler"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-subscribe-handler"; Path = "Supernoba-subscribe-handler"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-disconnect-handler"; Path = "Supernoba-disconnect-handler"; HasPackageJson = $false; HasBuild = $false },
    @{ Name = "Supernoba-admin-ws-handler"; Path = "Supernoba-admin-ws-handler"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-cleanup-handler"; Path = "Supernoba-cleanup-handler"; HasPackageJson = $true; HasBuild = $false },

    # === Event/Batch ===
    @{ Name = "Supernoba-push-sender"; Path = "Supernoba-push-sender"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-ipo-processor"; Path = "Supernoba-ipo-processor"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-auth"; Path = "Supernoba-auth"; HasPackageJson = $true; HasBuild = $false },

    # DEPRECATED: Supernoba-auth /auth/init 엔드포인트로 통합됨 - 2026-02-14
    # Supernoba-user-init

    # === Utility ===
    @{ Name = "Supernoba-ec2-mgmt"; Path = "Supernoba-ec2-mgmt"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-x-auth"; Path = "Supernoba-x-auth"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-symbol-cleanup"; Path = "Supernoba-symbol-cleanup"; HasPackageJson = $true; HasBuild = $false },

    # === Step Functions (delisting) ===
    @{ Name = "Supernoba-delisting-phase1"; Path = "Supernoba-delisting-phase1"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-delisting-phase2"; Path = "Supernoba-delisting-phase2"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-delisting-phase3"; Path = "Supernoba-delisting-phase3"; HasPackageJson = $true; HasBuild = $false },
    @{ Name = "Supernoba-delisting-phase4"; Path = "Supernoba-delisting-phase4"; HasPackageJson = $true; HasBuild = $false },

    # === Step Functions (delete-user) ===
    @{ Name = "Supernoba-delete-user-phase1"; Path = "Supernoba-delete-user-phase1"; HasPackageJson = $false; HasBuild = $false },
    @{ Name = "Supernoba-delete-user-phase2"; Path = "Supernoba-delete-user-phase2"; HasPackageJson = $false; HasBuild = $false },
    @{ Name = "Supernoba-delete-user-phase3"; Path = "Supernoba-delete-user-phase3"; HasPackageJson = $false; HasBuild = $false },
    @{ Name = "Supernoba-delete-user-phase4"; Path = "Supernoba-delete-user-phase4"; HasPackageJson = $false; HasBuild = $false },
    @{ Name = "Supernoba-delete-user-phase5"; Path = "Supernoba-delete-user-phase5"; HasPackageJson = $false; HasBuild = $false },
    @{ Name = "Supernoba-delete-user-phase6"; Path = "Supernoba-delete-user-phase6"; HasPackageJson = $false; HasBuild = $false }

    # DEPRECATED: stock-processor (C++)로 이전됨 - 2026-01-12
    # Supernoba-fill-processor, Supernoba-history-saver, Supernoba-notifier, Supernoba-order-status-processor
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
            if (Test-Path "package-lock.json") {
                npm ci 2>&1 | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    # If npm ci fails, try npm install
                    Write-Host "npm ci failed, trying npm install..." -ForegroundColor Yellow
                    npm install
                }
            } else {
                npm install
            }
            if ($LASTEXITCODE -ne 0) {
                throw "npm install failed"
            }
        }
        
        # Build (esbuild etc)
        if ($func.HasBuild) {
            Write-Host "Building..." -ForegroundColor Gray
            # Install dev dependencies for build tools
            npm install --include=dev
            if ($LASTEXITCODE -ne 0) {
                throw "npm install dev dependencies failed"
            }
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
            # Use 7zip or native zip if available, otherwise try Compress-Archive with retry
            $zipFile = Join-Path (Get-Location) "function.zip"
            $retryCount = 0
            $maxRetries = 3
            
            while ($retryCount -lt $maxRetries) {
                try {
                    Compress-Archive -Path "index.mjs", "package.json", "node_modules" -DestinationPath $zipFile -Force -CompressionLevel Fastest -ErrorAction Stop
                    break
                } catch {
                    $retryCount++
                    if ($retryCount -ge $maxRetries) {
                        # Fallback: use temp directory approach
                        $tempDir = Join-Path $env:TEMP "lambda-zip-$($func.Name)-$(Get-Random)"
                        New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
                        Copy-Item "index.mjs" $tempDir -Force
                        Copy-Item "package.json" $tempDir -Force
                        Copy-Item "node_modules" $tempDir -Recurse -Force
                        Set-Location $tempDir
                        Compress-Archive -Path * -DestinationPath $zipFile -Force -CompressionLevel Fastest
                        Set-Location $funcPath
                        Remove-Item $tempDir -Recurse -Force
                        break
                    }
                    Start-Sleep -Seconds 1
                }
            }
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
        $artifactsRemoved = 0
        if (Test-Path "function.zip") {
            Remove-Item "function.zip" -Force -ErrorAction SilentlyContinue
            $artifactsRemoved++
        }
        if (Test-Path "dist") {
            Remove-Item "dist" -Recurse -Force -ErrorAction SilentlyContinue
            $artifactsRemoved++
        }
        if (Test-Path "node_modules") {
            Remove-Item "node_modules" -Recurse -Force -ErrorAction SilentlyContinue
            $artifactsRemoved++
        }
        if (Test-Path "package-lock.json") {
            Remove-Item "package-lock.json" -Force -ErrorAction SilentlyContinue
            $artifactsRemoved++
        }
        if ($artifactsRemoved -gt 0) {
            Write-Host "  Removed $artifactsRemoved artifact(s)" -ForegroundColor Gray
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
