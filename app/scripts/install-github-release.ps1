param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$AssetName,
    [Parameter(Mandatory = $true)][string]$ExecutableName,
    [Parameter(Mandatory = $true)][string]$DestinationDirectory,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'install-common.ps1')
$headers = @{ 'User-Agent' = 'OmniShell-Installer/1.0'; 'Accept' = 'application/vnd.github+json' }

Write-OmniProgress -Percent 4 -Message "Resolving latest $Repository release"
$release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repository/releases/latest"
$asset = $release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
if (-not $asset) {
    throw "Release asset not found: $AssetName"
}

Write-OmniProgress -Percent 10 -Message "Release $($release.tag_name) resolved"
New-Item -ItemType Directory -Force -Path $WorkingDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
$archive = Join-Path $WorkingDirectory $AssetName
$partialArchive = "$archive.partial"
$expanded = Join-Path $WorkingDirectory ("expanded-" + [Guid]::NewGuid().ToString('N'))

try {
    Invoke-OmniTrackedDownload -Uri $asset.browser_download_url -Destination $partialArchive -StartPercent 14 -EndPercent 72 -Headers $headers
    if (-not (Test-Path -LiteralPath $partialArchive) -or (Get-Item -LiteralPath $partialArchive).Length -eq 0) {
        throw 'The downloaded release archive was empty.'
    }
    Move-Item -LiteralPath $partialArchive -Destination $archive -Force
}
finally {
    if (Test-Path -LiteralPath $partialArchive) {
        Remove-Item -LiteralPath $partialArchive -Force
    }
}

Write-OmniProgress -Percent 78 -Message 'Expanding release archive'
Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force

$executable = Get-ChildItem -LiteralPath $expanded -Recurse -File -Filter $ExecutableName | Select-Object -First 1
if (-not $executable) {
    throw "The archive did not contain $ExecutableName"
}

Write-OmniProgress -Percent 91 -Message "Installing $ExecutableName"
Copy-Item -LiteralPath $executable.FullName -Destination (Join-Path $DestinationDirectory $ExecutableName) -Force
Write-OmniProgress -Percent 96 -Message "Verifying $ExecutableName"
