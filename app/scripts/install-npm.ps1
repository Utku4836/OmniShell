param(
    [Parameter(Mandatory = $true)][string]$PackageName,
    [Parameter(Mandatory = $true)][string]$Destination,
    [ValidatePattern('^(latest|[0-9]+\.[0-9]+\.[0-9]+([-+][a-zA-Z0-9._-]+)?)$')][string]$PackageVersion = 'latest',
    [string]$AdditionalArgumentsJson = '[]',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-common.ps1')
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
}
if (-not $npm) {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\npm.cmd'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\npm.cmd'),
        (Join-Path $env:LOCALAPPDATA 'Programs\node\npm.cmd'),
        (Join-Path $env:APPDATA 'npm\npm.cmd')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            $npm = Get-Command $candidate -ErrorAction SilentlyContinue
            if ($npm) { break }
        }
    }
}
if (-not $npm) {
    throw 'npm was not found. Please ensure Node.js is installed (https://nodejs.org/) and npm is in your PATH.'
}

Write-OmniProgress -Percent 4 -Message 'Preparing isolated package directory'
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Push-Location -LiteralPath $Destination

try {
    Write-OmniProgress -Percent 12 -Message "Resolving $PackageName"
    $arguments = @('install', '--save-exact', ("{0}@{1}" -f $PackageName, $PackageVersion), '--no-fund', '--no-audit', '--loglevel=http', '--fetch-retries=2', '--fetch-timeout=60000')
    $parsedArguments = $AdditionalArgumentsJson | ConvertFrom-Json
    foreach ($argument in $parsedArguments) {
        $arguments += [string]$argument
    }
    if ($DryRun) {
        $arguments += '--dry-run'
    }

    & $npm.Source @arguments
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) {
        $exitCode = 0
    }
    if ($exitCode -ne 0) {
        exit $exitCode
    }
    Write-OmniProgress -Percent 90 -Message 'Package files installed'
    Write-OmniProgress -Percent 96 -Message 'Verifying local command'
}
finally {
    Pop-Location
}
