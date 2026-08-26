param(
    [Parameter(Mandatory = $true)][string]$BootstrapUri,
    [Parameter(Mandatory = $true)][string]$DestinationDirectory,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'install-common.ps1')

New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $WorkingDirectory | Out-Null

$bootstrap = Join-Path $WorkingDirectory 'cursor-install.ps1'
$bootstrapPartial = "$bootstrap.partial"
$archive = Join-Path $WorkingDirectory 'cursor-agent.zip'
$archivePartial = "$archive.partial"
$expanded = Join-Path $WorkingDirectory ("expanded-" + [Guid]::NewGuid().ToString('N'))

try {
    Write-OmniProgress -Percent 4 -Message 'Resolving official Cursor Windows release'
    Invoke-OmniTrackedDownload -Uri $BootstrapUri -Destination $bootstrapPartial -StartPercent 5 -EndPercent 9
    Move-Item -LiteralPath $bootstrapPartial -Destination $bootstrap -Force

    $bootstrapContent = Get-Content -Raw -LiteralPath $bootstrap
    $downloadMatch = [regex]::Match($bootstrapContent, '\$downloadUrl\s*=\s*''([^'']+)''')
    $versionMatch = [regex]::Match($bootstrapContent, '\$version\s*=\s*''([^'']+)''')
    if (-not $downloadMatch.Success -or -not $versionMatch.Success) {
        throw 'The official Cursor bootstrap did not expose a release URL and version.'
    }

    $downloadPrefix = $downloadMatch.Groups[1].Value
    $version = $versionMatch.Groups[1].Value
    $architecture = if ($env:PROCESSOR_ARCHITECTURE -match 'ARM64') { 'arm64' } else { 'x64' }
    $packageUri = $downloadPrefix + "windows/$architecture/agent-cli-package.zip"

    Write-OmniProgress -Percent 12 -Message "Cursor release $version resolved"
    Invoke-OmniTrackedDownload -Uri $packageUri -Destination $archivePartial -StartPercent 14 -EndPercent 72
    Move-Item -LiteralPath $archivePartial -Destination $archive -Force

    Write-OmniProgress -Percent 78 -Message 'Expanding Cursor Agent package'
    Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
    $packageRoot = Join-Path $expanded 'dist-package'
    if (-not (Test-Path -LiteralPath $packageRoot -PathType Container)) {
        $packageRoot = Get-ChildItem -LiteralPath $expanded -Directory -Recurse |
            Where-Object { $_.Name -eq 'dist-package' } |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $packageRoot) {
        throw 'The Cursor archive did not contain dist-package.'
    }

    $versionsDirectory = Join-Path $DestinationDirectory 'versions'
    $versionDirectory = Join-Path $versionsDirectory $version
    $basePath = [IO.Path]::GetFullPath($versionsDirectory).TrimEnd('\') + '\'
    $targetPath = [IO.Path]::GetFullPath($versionDirectory)
    if (-not $targetPath.StartsWith($basePath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to replace a Cursor version outside the isolated destination.'
    }

    New-Item -ItemType Directory -Force -Path $versionsDirectory | Out-Null
    if (Test-Path -LiteralPath $versionDirectory) {
        Remove-Item -LiteralPath $versionDirectory -Recurse -Force
    }
    Move-Item -LiteralPath $packageRoot -Destination $versionDirectory

    Write-OmniProgress -Percent 91 -Message 'Installing Cursor Agent command'
    Get-ChildItem -LiteralPath $versionDirectory -File -Filter 'cursor-agent*' |
        Copy-Item -Destination $DestinationDirectory -Force

    $executable = Get-ChildItem -LiteralPath $DestinationDirectory -File |
        Where-Object { $_.Name -in @('cursor-agent.exe', 'cursor-agent.cmd') } |
        Select-Object -First 1
    if (-not $executable) {
        throw 'Cursor Agent command was not found after extraction.'
    }
    Write-OmniProgress -Percent 96 -Message 'Verifying Cursor Agent command'
}
finally {
    foreach ($temporaryFile in @($bootstrapPartial, $archivePartial, $bootstrap, $archive)) {
        if (Test-Path -LiteralPath $temporaryFile) { Remove-Item -LiteralPath $temporaryFile -Force }
    }
    if (Test-Path -LiteralPath $expanded) {
        $expandedPath = [IO.Path]::GetFullPath($expanded)
        $workingPath = [IO.Path]::GetFullPath($WorkingDirectory).TrimEnd('\') + '\'
        if ($expandedPath.StartsWith($workingPath, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $expanded -Recurse -Force
        }
    }
}
