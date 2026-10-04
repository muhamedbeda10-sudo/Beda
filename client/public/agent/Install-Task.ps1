<#
.SYNOPSIS
  Registers the Access order sync with Windows Task Scheduler: every minute,
  for good, whether anyone is signed in or not.

.DESCRIPTION
  Run once, in a PowerShell window opened "as administrator", from the folder
  that holds Sync-AccessOrders.ps1 and config.json. It finds the PowerShell
  (64- or 32-bit) that can open the Access file — it must match the installed
  Access Database Engine — reads the table once as a dry run, then registers
  the task.

.PARAMETER AsSystem
  Run the task as the local SYSTEM account (no password). Only when the
  Access file is on this PC's own disk: SYSTEM cannot read a network share.
  Without it, the task runs as the account you name and asks its password.

.PARAMETER User
  The Windows account the task runs as. Defaults to the one running this.
#>
[CmdletBinding()]
param(
  [switch]$AsSystem,
  [string]$User = "$env:USERDOMAIN\$env:USERNAME"
)

$ErrorActionPreference = 'Stop'
$TaskName = 'QC Access order sync'
$Script = Join-Path $PSScriptRoot 'Sync-AccessOrders.ps1'
$Config = Join-Path $PSScriptRoot 'config.json'

if (-not (Test-Path -LiteralPath $Script)) { throw "Sync-AccessOrders.ps1 is not next to this script." }
if (-not (Test-Path -LiteralPath $Config)) { throw "config.json is not next to this script. Download it from the application." }

# The 64-bit and the 32-bit PowerShell; the Access engine works in one of them only.
$candidates = @(
  (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'),
  (Join-Path $env:WINDIR 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe')
) | Where-Object { Test-Path -LiteralPath $_ }

$shell = $null
foreach ($candidate in $candidates) {
  Write-Host "Trying $candidate ..."
  & $candidate -NoProfile -ExecutionPolicy Bypass -File $Script -ConfigPath $Config -DryRun
  if ($LASTEXITCODE -eq 0) { $shell = $candidate; break }
}
if ($null -eq $shell) {
  throw "Neither PowerShell could read the Access file. Install the Microsoft Access Database Engine (same 32/64-bit as Office) and check config.json."
}
Write-Host "Using $shell"

$action = "`"$shell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`" -ConfigPath `"$Config`""
if ($AsSystem) {
  schtasks.exe /Create /F /TN $TaskName /SC MINUTE /MO 1 /RU SYSTEM /RL HIGHEST /TR $action | Out-Host
} else {
  Write-Host "The task runs as $User; type that account's Windows password when asked."
  schtasks.exe /Create /F /TN $TaskName /SC MINUTE /MO 1 /RU $User /RP * /RL HIGHEST /TR $action | Out-Host
}
if ($LASTEXITCODE -ne 0) { throw "Task Scheduler refused the task (exit $LASTEXITCODE)." }

Write-Host ""
Write-Host "Done. '$TaskName' runs every minute; it syncs every 15 minutes, or within a minute of 'Sync now' in the application."
Write-Host "The log is sync.log next to the script. To stop: schtasks /Delete /TN `"$TaskName`" /F"
