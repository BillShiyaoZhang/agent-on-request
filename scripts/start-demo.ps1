$ErrorActionPreference = 'Stop'
$demoRoot = Split-Path -Parent $PSScriptRoot
$demoCandidates = @()
if ($env:AGENT_DEMO_NODE) { $demoCandidates += $env:AGENT_DEMO_NODE }
$demoNodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($demoNodeCommand) { $demoCandidates += $demoNodeCommand.Source }
$demoCandidates += Join-Path $demoRoot 'artifacts\qa-runtime\node.exe'
$demoNode = $null
foreach ($demoCandidate in $demoCandidates) {
  if (-not (Test-Path -LiteralPath $demoCandidate -PathType Leaf)) { continue }
  $demoVersion = & $demoCandidate --version
  if ($LASTEXITCODE -eq 0 -and $demoVersion -match '^v(\d+)\.' -and [int]$Matches[1] -ge 26) { $demoNode = $demoCandidate; break }
}
if (-not $demoNode) { throw 'Node.js 26+ is required. Install Node.js 26+, or set AGENT_DEMO_NODE to its node.exe path.' }
Write-Host "Using $demoNode"
& $demoNode (Join-Path $PSScriptRoot 'demo.mjs')
exit $LASTEXITCODE
