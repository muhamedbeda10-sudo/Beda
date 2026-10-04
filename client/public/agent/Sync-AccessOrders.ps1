<#
.SYNOPSIS
  Sends the factory's order sheet from its Access database to the QC application.

.DESCRIPTION
  Run every minute by Windows Task Scheduler (see Install-Task.ps1). Each time
  it asks the application whether a sync is due: every 15 minutes, or sooner
  when an administrator presses "Sync now". When one is due it opens the
  Access file READ-ONLY, reads the orders table (or query), and sends every
  row in batches with the integration key. The application maps the columns,
  updates the order lines, and retires the lines the table no longer carries
  only when every row arrived and read cleanly.

  The Access file is never written to.

.PARAMETER ConfigPath
  The config.json downloaded from the application (Administration > Data
  import > Access sync). Defaults to config.json next to this script.

.PARAMETER DryRun
  Reads the table and prints what it found (rows, columns, the first row)
  without sending anything. Use it once after setting up.

.PARAMETER Force
  Syncs now, without asking whether a sync is due.
#>
[CmdletBinding()]
param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json'),
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---- Configuration -----------------------------------------------------------

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  Write-Error "No config file at $ConfigPath. Download config.json from the application and put it next to this script."
  exit 2
}
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

function Get-Setting([string]$Name, $Default = $null) {
  $p = $config.PSObject.Properties[$Name]
  if ($null -eq $p -or $null -eq $p.Value -or "$($p.Value)".Trim() -eq '') { return $Default }
  return $p.Value
}

$ApiUrl = "$(Get-Setting 'apiUrl')".TrimEnd('/')
$ApiKey = "$(Get-Setting 'apiKey')"
$DatabasePath = "$(Get-Setting 'databasePath')"
$Table = Get-Setting 'table'
$Query = Get-Setting 'query'
$DatabasePassword = Get-Setting 'databasePassword'
$LogPath = Get-Setting 'logPath' (Join-Path $PSScriptRoot 'sync.log')

foreach ($required in @(@('apiUrl', $ApiUrl), @('apiKey', $ApiKey), @('databasePath', $DatabasePath))) {
  if ($required[1] -eq '' -or $required[1] -like '*<*') {
    Write-Error "config.json: '$($required[0])' is not set."
    exit 2
  }
}
if ($null -eq $Table -and $null -eq $Query) {
  Write-Error "config.json: set 'table' (the orders table) or 'query' (a SELECT)."
  exit 2
}
$Source = Get-Setting 'source' ("$env:COMPUTERNAME · " + $(if ($null -ne $Query) { 'query' } else { $Table }))

# ---- Log ---------------------------------------------------------------------

function Write-Log([string]$Message) {
  $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $Message
  Write-Host $line
  try {
    if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 5MB) {
      Move-Item -LiteralPath $LogPath -Destination "$LogPath.old" -Force
    }
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch {
    # A log that cannot be written must not stop the sync.
  }
}

# ---- The application ---------------------------------------------------------

function Invoke-Api([string]$Method, [string]$Path, $Body = $null) {
  $params = @{
    Uri         = "$ApiUrl/api/agent/order-sync$Path"
    Method      = $Method
    Headers     = @{ Authorization = "Bearer $ApiKey" }
    TimeoutSec  = 180
    ErrorAction = 'Stop'
  }
  if ($null -ne $Body) {
    $json = ConvertTo-Json -InputObject $Body -Depth 6 -Compress
    $params.ContentType = 'application/json; charset=utf-8'
    $params.Body = [Text.Encoding]::UTF8.GetBytes($json)
  }
  try {
    return Invoke-RestMethod @params
  } catch {
    $detail = $_.Exception.Message
    if ($null -ne $_.ErrorDetails -and $_.ErrorDetails.Message) { throw "The application answered ${Method} ${Path}: $detail $($_.ErrorDetails.Message)" }
    $response = $_.Exception.PSObject.Properties['Response']
    if ($null -ne $response -and $null -ne $response.Value) {
      try {
        $reader = New-Object IO.StreamReader($response.Value.GetResponseStream())
        $text = $reader.ReadToEnd()
        if ($text) { $detail = "$detail $text" }
      } catch { }
    }
    throw "The application answered ${Method} ${Path}: $detail"
  }
}

# ---- The Access database -----------------------------------------------------

function Open-Access {
  $last = $null
  foreach ($provider in @('Microsoft.ACE.OLEDB.16.0', 'Microsoft.ACE.OLEDB.12.0')) {
    $cs = "Provider=$provider;Data Source=$DatabasePath;Mode=Read;Persist Security Info=False;"
    if ($null -ne $DatabasePassword) { $cs += "Jet OLEDB:Database Password=$DatabasePassword;" }
    $connection = New-Object System.Data.OleDb.OleDbConnection($cs)
    try {
      $connection.Open()
      return $connection
    } catch {
      $last = $_.Exception.Message
      $connection.Dispose()
    }
  }
  throw "Could not open $DatabasePath read-only: $last (Is the Access Database Engine installed, with the same 32/64-bit as this PowerShell? Install-Task.ps1 picks the right one.)"
}

function Read-Orders {
  $connection = Open-Access
  try {
    $sql = if ($null -ne $Query) { "$Query" } else { "SELECT * FROM [$Table]" }
    $command = $connection.CreateCommand()
    $command.CommandText = $sql
    $command.CommandTimeout = 300
    $data = New-Object System.Data.DataTable
    $adapter = New-Object System.Data.OleDb.OleDbDataAdapter($command)
    [void]$adapter.Fill($data)
  } finally {
    $connection.Close()
    $connection.Dispose()
  }
  $columns = @($data.Columns | ForEach-Object { $_.ColumnName })
  $rows = New-Object System.Collections.Generic.List[object]
  foreach ($r in $data.Rows) {
    $row = [ordered]@{}
    foreach ($c in $columns) {
      $v = $r[$c]
      if ($v -is [DBNull]) { $row[$c] = $null }
      elseif ($v -is [DateTime]) { $row[$c] = $v.ToString("yyyy-MM-dd'T'HH:mm:ss") }
      elseif ($v -is [decimal] -or $v -is [double] -or $v -is [single] -or $v -is [int] -or $v -is [long] -or $v -is [int16] -or $v -is [byte]) { $row[$c] = [double]$v }
      elseif ($v -is [bool]) { $row[$c] = [string]$v }
      else { $row[$c] = ([string]$v).Trim() }
    }
    $rows.Add($row)
  }
  return @{ Columns = $columns; Rows = $rows }
}

# ---- One sync ----------------------------------------------------------------

# One sync at a time on this PC, whatever starts it.
$mutex = New-Object System.Threading.Mutex($false, 'Global\QcAccessOrderSync')
try {
  if (-not $mutex.WaitOne(0)) { exit 0 }
} catch [System.Threading.AbandonedMutexException] {
  # The last run ended without letting go: the mutex is ours now.
}

$runId = $null
try {
  if ($DryRun) {
    $read = Read-Orders
    Write-Host "Read $($read.Rows.Count) rows from $DatabasePath."
    Write-Host ("Columns: " + ($read.Columns -join ', '))
    if ($read.Rows.Count -gt 0) { Write-Host ("First row: " + (ConvertTo-Json -InputObject $read.Rows[0] -Compress)) }
    Write-Host 'Dry run: nothing was sent.'
    exit 0
  }

  if (-not $Force) {
    $due = Invoke-Api 'GET' '/due'
    if (-not $due.due) { exit 0 }
    Write-Log "Sync due ($($due.reason))."
  }

  # The run starts before the file is read, so a file that cannot be opened shows as a failed run in the application.
  try {
    $start = Invoke-Api 'POST' '/runs' @{ source = "$Source" }
  } catch {
    if ("$_" -like '*already running*') { Write-Log 'Another sync is running; this one stops.'; exit 0 }
    throw
  }
  $runId = $start.runId
  $batchMax = [int]$start.batchMax
  $read = Read-Orders
  $total = $read.Rows.Count
  Write-Log "Run ${runId}: sending $total rows in batches of $batchMax."

  $all = $read.Rows.ToArray()
  for ($i = 0; $i -lt $total; $i += $batchMax) {
    $last = [Math]::Min($i + $batchMax, $total) - 1
    $batch = @($all[$i..$last])
    [void](Invoke-Api 'POST' "/runs/$runId/rows" @{ rows = $batch })
  }

  $done = Invoke-Api 'POST' "/runs/$runId/finish" @{ total = $total }
  $note = if ($done.PSObject.Properties['message'] -and $done.message) { " $($done.message)" } else { '' }
  Write-Log ("Run {0}: {1} · {2} inserted, {3} updated, {4} retired, {5} unreadable.{6}" -f $runId, $done.status, $done.inserted, $done.updated, $done.retired, $done.invalid, $note)
  exit 0
} catch {
  $message = "$_"
  Write-Log "Sync failed: $message"
  if ($null -ne $runId) {
    try { [void](Invoke-Api 'POST' "/runs/$runId/fail" @{ message = $message.Substring(0, [Math]::Min(1000, $message.Length)) }) } catch { }
  }
  exit 1
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
