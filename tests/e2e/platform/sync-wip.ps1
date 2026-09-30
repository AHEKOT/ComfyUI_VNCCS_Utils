param(
  [Parameter(Mandatory = $true)][string]$Target,          # e.g. root@69.30.85.249
  [int]$Port = 22,
  [string]$Source = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$RemoteDir = '/opt/ComfyUI/custom_nodes/ComfyUI_VNCCS_Utils'
)
$ErrorActionPreference = 'Stop'
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ('vnccs-wip-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
foreach ($dir in 'web', 'nodes') {
  Copy-Item (Join-Path $Source $dir) (Join-Path $staging $dir) -Recurse
}
$archive = Join-Path $staging 'wip.tar.gz'
tar -czf $archive -C $staging web nodes
ssh -p $Port $Target "mkdir -p $RemoteDir"
scp -P $Port $archive "${Target}:${RemoteDir}/wip.tar.gz"
ssh -p $Port $Target "tar -xzf $RemoteDir/wip.tar.gz -C $RemoteDir && rm $RemoteDir/wip.tar.gz && (pkill -f 'python.*main.py' || true)"
Write-Output "WIP synced to ${Target}:${RemoteDir}. ComfyUI restarts via the platform's auto-restart; poll COMFYUI_URL/system_stats before testing."
