# Nyx — Local AI: Windows installer (PowerShell)
#
#   irm https://raw.githubusercontent.com/sthamann/nyx-local-ai/main/install.ps1 | iex
#
# Or with options:
#   .\install.ps1 -Editor cursor -Version v0.24.1
#
param(
  [ValidateSet('cursor', 'code', 'all')]
  [string]$Editor = 'all',
  [string]$Version = 'latest',
  [string]$Vsix = '',
  [string]$Repo = 'sthamann/nyx-local-ai'
)

$ErrorActionPreference = 'Stop'
$ExtId = 'local.nyx-local-ai'

function Find-Cli([string]$Name, [string[]]$Fallbacks) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($f in $Fallbacks) {
    if (Test-Path $f) { return $f }
  }
  return $null
}

Write-Host "Nyx — Local AI installer" -ForegroundColor Cyan

$cursorCli = Find-Cli 'cursor' @(
  "$env:LOCALAPPDATA\Programs\cursor\resources\app\bin\cursor.cmd"
)
$codeCli = Find-Cli 'code' @(
  "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
  "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd"
)

$targets = @()
if (($Editor -eq 'cursor' -or $Editor -eq 'all') -and $cursorCli) {
  $targets += @{ Name = 'cursor'; Cli = $cursorCli; ExtDir = "$env:USERPROFILE\.cursor\extensions" }
}
if (($Editor -eq 'code' -or $Editor -eq 'all') -and $codeCli) {
  $targets += @{ Name = 'code'; Cli = $codeCli; ExtDir = "$env:USERPROFILE\.vscode\extensions" }
}
if ($targets.Count -eq 0) { throw 'No editor CLI found. Install Cursor or VS Code first.' }

foreach ($t in $targets) { Write-Host "  found $($t.Name): $($t.Cli)" -ForegroundColor Green }

# Obtain the .vsix
$tmp = Join-Path $env:TEMP "nyx-install-$(Get-Random)"
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  if ($Vsix) {
    if (-not (Test-Path $Vsix)) { throw "No such file: $Vsix" }
    $vsixPath = $Vsix
  } else {
    $base = if ($Version -eq 'latest') {
      "https://github.com/$Repo/releases/latest/download"
    } else {
      "https://github.com/$Repo/releases/download/$Version"
    }
    $vsixPath = Join-Path $tmp 'nyx-local-ai.vsix'
    Write-Host "  downloading $base/nyx-local-ai.vsix ..."
    Invoke-WebRequest -Uri "$base/nyx-local-ai.vsix" -OutFile $vsixPath

    # Verify checksum when published (best effort).
    try {
      $checksums = (Invoke-WebRequest -Uri "$base/checksums.txt").Content
      $expected = ($checksums -split "`n" | Where-Object { $_ -match 'nyx-local-ai\.vsix' } | Select-Object -First 1) -split '\s+' | Select-Object -First 1
      if ($expected) {
        $actual = (Get-FileHash -Algorithm SHA256 $vsixPath).Hash.ToLower()
        if ($expected.ToLower() -ne $actual) { throw "Checksum mismatch: expected $expected, got $actual" }
        Write-Host "  checksum verified" -ForegroundColor Green
      }
    } catch [System.Net.WebException] {
      # no checksums published — continue
    }
  }

  foreach ($t in $targets) {
    # No manual cleanup of old version folders — `--force` upgrades in place;
    # deleting folders by hand corrupts the editor's extension registry.
    Write-Host "  installing into $($t.Name) ..."
    & $t.Cli --install-extension $vsixPath --force | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "'$($t.Cli) --install-extension' failed" }
    Write-Host "  installed into $($t.Name) ($ExtId)" -ForegroundColor Green
  }
} finally {
  if (-not $Vsix) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host 'Done! Next steps:' -ForegroundColor Cyan
Write-Host '  1. Reload your editor window (Ctrl+Shift+P -> "Developer: Reload Window").'
Write-Host '  2. Open the Nyx icon in the Activity Bar (or press Ctrl+Alt+N).'
Write-Host '  3. Have a local model ready, e.g.:  ollama pull qwen2.5-coder:32b'
