param([string]$SecretsPath = (Join-Path $PSScriptRoot '../../.env.production.local'))
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
if (!(Test-Path -LiteralPath $SecretsPath)) { throw 'Encrypted deployment secrets file not found. Pass -SecretsPath.' }
$secure = ConvertTo-SecureString ([IO.File]::ReadAllText((Resolve-Path -LiteralPath $SecretsPath)))
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $settings = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) | ConvertFrom-Json
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
$keys = @('APP_DATABASE_URL', 'GLOBAL_DATABASE_URL', 'DBOS_SYSTEM_DATABASE_URL', 'ABCRM_KEY_PROVIDER', 'ABCRM_MASTER_KEY', 'ABCRM_PLATFORM_HMAC_KEY', 'ABCRM_PLATFORM_CACHE_KEY')
$previous = @{}
foreach ($key in ($keys + 'NODE_ENV')) { $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
try {
    foreach ($key in $keys) {
        if (!$settings.$key) { throw "Missing required setting: $key" }
        [Environment]::SetEnvironmentVariable($key, $settings.$key, 'Process')
    }
    $env:NODE_ENV = 'production'
    Push-Location $repoRoot
    try { & node --import tsx apps/worker/src/worker.ts; $workerExit = $LASTEXITCODE } finally { Pop-Location }
} finally {
    foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
}
exit $workerExit
