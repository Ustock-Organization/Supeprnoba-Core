# Clean Build Artifacts Script
# Usage: .\clean-artifacts.ps1
# Removes all build artifacts from Lambda function directories

$ErrorActionPreference = "Stop"

# Get script directory (should be liquibook/lambda/)
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$LAMBDA_DIR = $SCRIPT_DIR

# Lambda function directories
$LAMBDA_FUNCTIONS = @(
    "Supernoba-admin",
    "Supernoba-order-router",
    "Supernoba-asset-handler",
    "Supernoba-fill-processor",
    "Supernoba-history-saver",
    "Supernoba-notifier",
    "Supernoba-chart-data-handler",
    "Supernoba-connect-handler",
    "Supernoba-subscribe-handler",
    "Supernoba-disconnect-handler"
)

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Cleaning Build Artifacts" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

$cleaned = 0
$totalSize = 0

foreach ($funcName in $LAMBDA_FUNCTIONS) {
    $funcPath = Join-Path $LAMBDA_DIR $funcName
    
    if (-not (Test-Path $funcPath)) {
        Write-Host "[$funcName] Directory not found, skipping..." -ForegroundColor Yellow
        continue
    }
    
    Write-Host "----------------------------------------" -ForegroundColor Yellow
    Write-Host "[$funcName] Cleaning..." -ForegroundColor Yellow
    
    $funcSize = 0
    
    # Remove all ZIP files
    $zipFiles = Get-ChildItem -Path $funcPath -Filter "*.zip" -File -ErrorAction SilentlyContinue
    foreach ($zipFile in $zipFiles) {
        $size = $zipFile.Length
        Remove-Item $zipFile.FullName -Force -ErrorAction SilentlyContinue
        $funcSize += $size
        Write-Host "  Removed: $($zipFile.Name) ($([math]::Round($size / 1MB, 2)) MB)" -ForegroundColor Gray
    }
    
    # Remove dist directory
    $distPath = Join-Path $funcPath "dist"
    if (Test-Path $distPath) {
        $size = (Get-ChildItem $distPath -Recurse -File | Measure-Object -Property Length -Sum).Sum
        Remove-Item $distPath -Recurse -Force -ErrorAction SilentlyContinue
        $funcSize += $size
        Write-Host "  Removed: dist/ ($([math]::Round($size / 1MB, 2)) MB)" -ForegroundColor Gray
    }
    
    # Remove node_modules directory
    $nodeModulesPath = Join-Path $funcPath "node_modules"
    if (Test-Path $nodeModulesPath) {
        $size = (Get-ChildItem $nodeModulesPath -Recurse -File | Measure-Object -Property Length -Sum).Sum
        Remove-Item $nodeModulesPath -Recurse -Force -ErrorAction SilentlyContinue
        $funcSize += $size
        Write-Host "  Removed: node_modules/ ($([math]::Round($size / 1MB, 2)) MB)" -ForegroundColor Gray
    }
    
    # Remove package-lock.json
    $lockPath = Join-Path $funcPath "package-lock.json"
    if (Test-Path $lockPath) {
        $size = (Get-Item $lockPath).Length
        Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
        $funcSize += $size
        Write-Host "  Removed: package-lock.json" -ForegroundColor Gray
    }
    
    if ($funcSize -gt 0) {
        $totalSize += $funcSize
        $cleaned++
        Write-Host "  Total cleaned: $([math]::Round($funcSize / 1MB, 2)) MB" -ForegroundColor Green
    } else {
        Write-Host "  No artifacts found" -ForegroundColor Gray
    }
    
    Write-Host ""
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Cleanup Complete" -ForegroundColor Cyan
Write-Host "Functions cleaned: $cleaned" -ForegroundColor Green
Write-Host "Total space freed: $([math]::Round($totalSize / 1MB, 2)) MB" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan

