param(
	[int]$Port = 15721
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:PORT = [string]$Port

node (Join-Path $scriptDir "launcher.js")
