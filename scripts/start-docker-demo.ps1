param([ValidateRange(1024, 65535)][int]$Port = 4327)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $projectRoot 'compose.hermes-demo.yaml'
$settingsDirectory = Join-Path $projectRoot '.data/docker-hermes'
$settingsFile = Join-Path $settingsDirectory 'compose.env'
$hermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
$hermesEnv = Join-Path $hermesHome '.env'

function Read-MiniMaxKey {
  $key = $null
  if (Test-Path -LiteralPath $hermesEnv -PathType Leaf) {
    foreach ($line in [IO.File]::ReadLines($hermesEnv)) {
      $assignment = [regex]::Match($line, '^\s*(?:export\s+)?MINIMAX_CN_API_KEY\s*=\s*(?<value>[^#]*)')
      if ($assignment.Success) {
        $key = $assignment.Groups['value'].Value.Trim().Trim([char[]]@([char]34, [char]39))
      }
    }
  }
  if ($key) { return $key }
  return $env:MINIMAX_CN_API_KEY
}

$minimaxKey = Read-MiniMaxKey
if ($minimaxKey -cnotmatch '^[A-Za-z0-9._-]{16,512}$') {
  throw 'Set MINIMAX_CN_API_KEY in the local Hermes .env or the process environment.'
}

function New-GatewayKey {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

if (-not (Test-Path -LiteralPath $settingsFile -PathType Leaf)) {
  New-Item -Path $settingsDirectory -ItemType Directory -Force | Out-Null
  $settings = "DEMO_HERMES_ALICE_KEY=$(New-GatewayKey)`nDEMO_HERMES_BOB_KEY=$(New-GatewayKey)`n"
  $file = [IO.File]::Open($settingsFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $bytes = [Text.Encoding]::ASCII.GetBytes($settings)
    $file.Write($bytes, 0, $bytes.Length)
  } finally { $file.Dispose() }
}

$originalPort = $env:DEMO_DOCKER_PORT
$originalAliceKey = $env:DEMO_HERMES_ALICE_KEY
$originalBobKey = $env:DEMO_HERMES_BOB_KEY
$env:DEMO_DOCKER_PORT = [string]$Port
$env:DEMO_HERMES_ALICE_KEY = $null
$env:DEMO_HERMES_BOB_KEY = $null
try {
  $compose = @('--project-name', 'agent-on-request-hermes-demo', '--env-file', $settingsFile, '-f', $composeFile)
  docker compose @compose build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  foreach ($role in 'hermes-alice', 'hermes-bob') {
    $minimaxKey | docker compose @compose run --rm --no-deps -T -i --user root -e HERMES_HOME=/opt/data --entrypoint /opt/hermes/.venv/bin/python $role /opt/hermes/configure-demo-profile.py
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  docker compose @compose up -d --no-build --remove-orphans --wait --wait-timeout 240
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  $minimaxKey = $null
  $env:DEMO_DOCKER_PORT = $originalPort
  $env:DEMO_HERMES_ALICE_KEY = $originalAliceKey
  $env:DEMO_HERMES_BOB_KEY = $originalBobKey
}
Write-Host "Hermes direct demo is ready at http://127.0.0.1:$Port"
