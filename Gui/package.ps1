<#
.SYNOPSIS
  Package Google Photos Recovery GUI for distribution.
  Output: Google Photos Recovery.zip
         dist\
           Google Photos Recovery.bat   <- double-click to launch
           source\                      <- app + node_modules
#>
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$distDir   = Join-Path $scriptDir 'dist'
$sourceDir = Join-Path $distDir   'source'
$zipPath   = Join-Path $scriptDir 'Google Photos Recovery.zip'

# Clean dist
if (Test-Path $distDir) { Remove-Item $distDir -Recurse -Force }
New-Item -ItemType Directory $sourceDir | Out-Null
Write-Host 'Created dist\source\'

# Copy app files (skip build artifacts and dev-only items)
$skip = @('dist', 'build', 'node_modules', 'build.mjs', 'package.ps1')
Get-ChildItem $scriptDir -Exclude $skip | ForEach-Object {
  Copy-Item $_.FullName $sourceDir -Recurse
}
Write-Host 'Copied app sources'

# Install production dependencies into source\
Write-Host 'Installing production dependencies...'
Push-Location $sourceDir
npm install --omit=dev --silent
Pop-Location
Write-Host 'Dependencies installed'

# Create launcher bat (ASCII — no BOM, cmd.exe reads it cleanly)
@'
@echo off
title Google Photos Recovery
cd /d "%~dp0source"
node server.mjs
'@ | Set-Content (Join-Path $distDir 'Google Photos Recovery.bat') -Encoding ASCII
Write-Host 'Created launcher bat'

# Copy adb\ if present (WORK_DIR = dist\, so adb\ must sit next to the bat)
$adbSrc = Join-Path (Split-Path $scriptDir -Parent) 'adb'
if (Test-Path $adbSrc) {
  Copy-Item $adbSrc (Join-Path $distDir 'adb') -Recurse
  Write-Host 'Copied adb\'
} else {
  Write-Host 'adb\ not found — skipped (place it next to the .bat after unzip)'
}

# Zip dist\ -> Google Photos Recovery.zip
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path "$distDir\*" -DestinationPath $zipPath

$sizeMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host ""
Write-Host "Done: Google Photos Recovery.zip ($sizeMb MB)"
Write-Host ""
Write-Host "Contents:"
Write-Host "  Google Photos Recovery.bat  -- double-click to start"
Write-Host "  source\                     -- app + node_modules"
Write-Host ""
Write-Host "Requires Node.js installed on the target machine."
