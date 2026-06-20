param()

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Push-Location $scriptDir
try {
	if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
		throw "npm not found. Install Node.js first, or keep using start.ps1."
	}

	if (Test-Path (Join-Path $scriptDir "package-lock.json")) {
		npm ci
	} else {
		npm install
	}

	npm run build:win

	$exePath = Join-Path $scriptDir "dist\stream-rec-r2-downloader.exe"
	Write-Host "Generated: $exePath"
} finally {
	Pop-Location
}
