param(
    [Parameter(Mandatory = $true)][string]$ManifestUri,
    [Parameter(Mandatory = $true)][string]$DestinationDirectory,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-common.ps1')
New-Item -ItemType Directory -Force -Path $WorkingDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
$manifestPath = Join-Path $WorkingDirectory 'release.json'
$download = Join-Path $WorkingDirectory 'agy.exe.partial'
$target = Join-Path $DestinationDirectory 'agy.exe'
$replacement = Join-Path $DestinationDirectory 'agy.exe.partial'
try {
    Write-OmniProgress -Percent 4 -Message 'Resolving Antigravity release'
    Invoke-OmniTrackedDownload -Uri $ManifestUri -Destination $manifestPath -StartPercent 5 -EndPercent 10
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if (-not $manifest.version -or -not $manifest.sha512 -or -not ([string]$manifest.url).StartsWith('https://')) {
        throw 'The Antigravity release manifest is invalid.'
    }
    Invoke-OmniTrackedDownload -Uri $manifest.url -Destination $download -StartPercent 12 -EndPercent 85
    Write-OmniProgress -Percent 88 -Message 'Checking Antigravity download integrity'
    $hasher = [System.Security.Cryptography.SHA512]::Create()
    $stream = [System.IO.File]::OpenRead($download)
    try {
        $hash = [System.BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '')
    } finally {
        $stream.Dispose()
        $hasher.Dispose()
    }
    if ($hash -ne $manifest.sha512) { throw 'Antigravity download checksum mismatch.' }
    # Keep the old executable in place until the new download is complete and verified.
    Copy-Item -LiteralPath $download -Destination $replacement -Force
    if (Test-Path -LiteralPath $target) { [IO.File]::Replace($replacement, $target, $null) }
    else { [IO.File]::Move($replacement, $target) }
    Unblock-File -LiteralPath $target -ErrorAction SilentlyContinue
    Write-OmniProgress -Percent 96 -Message ("Installed Antigravity {0}" -f $manifest.version)
} finally {
    if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Force }
    if (Test-Path -LiteralPath $replacement) { Remove-Item -LiteralPath $replacement -Force }
}
