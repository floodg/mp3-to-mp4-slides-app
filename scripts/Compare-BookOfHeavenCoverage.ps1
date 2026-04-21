<#
.SYNOPSIS
  Compares the Book of Heaven MP3 source folder against rendered transcripts and
  MP4 exports, and reports which (Volume, Number) pairs are missing from each.

.DESCRIPTION
  Walks the MP3 source tree recursively and the two output folders non-recursively,
  normalises every file stem into a (Volume, Number) tuple via a tolerant regex
  (handles "Copy of Vol X No Y", "Vol 18 - audio Y", "Volume 30 - audio No Y",
  "Book of Heaven Volume X - Number Y", etc.), and prints:
    - totals for each folder
    - MP3s with no transcript
    - MP3s with no MP4 export
    - orphan transcripts / MP4s (rendered files with no matching source MP3)
    - any filenames whose Volume/Number could not be parsed

.PARAMETER Mp3Root
  Root folder containing MP3 subfolders (Vol 1, Vol 2, ... Vol 30).

.PARAMETER TranscriptsDir
  Folder containing generated .txt / .srt / .vtt transcripts. The script only
  counts .txt to avoid triple-counting each recording.

.PARAMETER ExportsDir
  Folder containing exported .mp4 files.

.EXAMPLE
  .\Compare-BookOfHeavenCoverage.ps1

.EXAMPLE
  .\Compare-BookOfHeavenCoverage.ps1 -Mp3Root 'D:\Audio\BoH'
#>
[CmdletBinding()]
param(
  [string] $Mp3Root = 'C:\Users\gerar\OneDrive\Documents\Book of Heaven - Francis Hogan\MP3s',
  [string] $TranscriptsDir,
  [string] $ExportsDir
)

$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$repoRoot = Split-Path -Parent $scriptDir

if (-not $TranscriptsDir) { $TranscriptsDir = Join-Path $repoRoot 'output\transcripts' }
if (-not $ExportsDir)     { $ExportsDir     = Join-Path $repoRoot 'output\exports' }

$Mp3Root        = (Resolve-Path -LiteralPath $Mp3Root).Path
$TranscriptsDir = (Resolve-Path -LiteralPath $TranscriptsDir).Path
$ExportsDir     = (Resolve-Path -LiteralPath $ExportsDir).Path

function Get-VolNum {
  param([string] $Stem)
  $s = $Stem `
    -replace '^Book of Heaven\s+', '' `
    -replace '^Copy of\s+', '' `
    -replace '^DW\s+', '' `
    -replace '\s+', ' '

  $v = $null; $n = $null
  if ($s -match 'Vol(?:ume)?\s*(\d+)') { $v = [int]$Matches[1] }
  if ($s -match '(?:No\.?|N0\.?|Number|audio(?:\s+No)?)\s*\.?\s*(\d+)') {
    $n = [int]$Matches[1]
  } elseif ($s -match '\b(\d+)\s*$') {
    $n = [int]$Matches[1]
  }
  if ($null -ne $v -and $null -ne $n) {
    return [pscustomobject]@{ Vol = $v; Num = $n }
  }
  return $null
}

function Sort-VolNumKeys {
  param([string[]] $Keys)
  $Keys | Sort-Object `
    @{ Expression = { [int]($_ -split '-')[0] } }, `
    @{ Expression = { [int]($_ -split '-')[1] } }
}

function Build-Index {
  param(
    [string[]] $Paths,
    [bool] $StripDir
  )
  $set = @{}
  $unmatched = New-Object System.Collections.Generic.List[string]
  foreach ($p in $Paths) {
    $stem = [System.IO.Path]::GetFileNameWithoutExtension($p)
    $vn = Get-VolNum $stem
    $key = if ($vn) { "$($vn.Vol)-$($vn.Num)" } else { $null }
    if ($key) {
      if (-not $set.ContainsKey($key)) { $set[$key] = $p }
    } else {
      $unmatched.Add($p) | Out-Null
    }
  }
  return [pscustomobject]@{ Set = $set; Unmatched = $unmatched }
}

$mp3Paths = [System.IO.Directory]::EnumerateFiles(
  $Mp3Root, '*.*', [System.IO.SearchOption]::AllDirectories
) | Where-Object { $_ -match '\.(mp3|wav|m4a|aac)$' }

$transPaths = Get-ChildItem -LiteralPath $TranscriptsDir -File -Filter '*.txt' `
  | ForEach-Object { $_.FullName }

$exportPaths = Get-ChildItem -LiteralPath $ExportsDir -File -Filter '*.mp4' `
  | ForEach-Object { $_.FullName }

$mp3Idx    = Build-Index -Paths $mp3Paths    -StripDir $true
$transIdx  = Build-Index -Paths $transPaths  -StripDir $false
$exportIdx = Build-Index -Paths $exportPaths -StripDir $false

Write-Host "=== COUNTS ==="
Write-Host ("MP3 audio files:              {0}  (matched: {1}, unmatched: {2})" -f `
  @($mp3Paths).Count, $mp3Idx.Set.Count, $mp3Idx.Unmatched.Count)
Write-Host ("Transcripts (.txt in folder): {0}  (matched: {1}, unmatched: {2})" -f `
  @($transPaths).Count, $transIdx.Set.Count, $transIdx.Unmatched.Count)
Write-Host ("MP4 exports:                  {0}  (matched: {1}, unmatched: {2})" -f `
  @($exportPaths).Count, $exportIdx.Set.Count, $exportIdx.Unmatched.Count)
Write-Host ""

$missingTrans = @()
$missingExport = @()
foreach ($k in $mp3Idx.Set.Keys) {
  if (-not $transIdx.Set.ContainsKey($k))  { $missingTrans  += $k }
  if (-not $exportIdx.Set.ContainsKey($k)) { $missingExport += $k }
}

Write-Host ("=== MP3s WITHOUT a transcript ({0}) ===" -f $missingTrans.Count)
foreach ($k in (Sort-VolNumKeys $missingTrans)) {
  $src = $mp3Idx.Set[$k]
  $rel = $src.Substring($Mp3Root.Length + 1)
  Write-Host ("  Vol {0}  No {1}   <-  {2}" -f ($k -split '-')[0], ($k -split '-')[1], $rel)
}

Write-Host ""
Write-Host ("=== MP3s WITHOUT an MP4 export ({0}) ===" -f $missingExport.Count)
foreach ($k in (Sort-VolNumKeys $missingExport)) {
  $src = $mp3Idx.Set[$k]
  $rel = $src.Substring($Mp3Root.Length + 1)
  Write-Host ("  Vol {0}  No {1}   <-  {2}" -f ($k -split '-')[0], ($k -split '-')[1], $rel)
}

$orphanTrans  = @($transIdx.Set.Keys  | Where-Object { -not $mp3Idx.Set.ContainsKey($_) })
$orphanExport = @($exportIdx.Set.Keys | Where-Object { -not $mp3Idx.Set.ContainsKey($_) })

Write-Host ""
Write-Host ("=== Transcripts with no matching MP3 ({0}) ===" -f $orphanTrans.Count)
foreach ($k in (Sort-VolNumKeys $orphanTrans)) {
  Write-Host ("  Vol {0}  No {1}   ->  {2}" -f ($k -split '-')[0], ($k -split '-')[1], (Split-Path -Leaf $transIdx.Set[$k]))
}

Write-Host ""
Write-Host ("=== MP4 exports with no matching MP3 ({0}) ===" -f $orphanExport.Count)
foreach ($k in (Sort-VolNumKeys $orphanExport)) {
  Write-Host ("  Vol {0}  No {1}   ->  {2}" -f ($k -split '-')[0], ($k -split '-')[1], (Split-Path -Leaf $exportIdx.Set[$k]))
}

if ($mp3Idx.Unmatched.Count -or $transIdx.Unmatched.Count -or $exportIdx.Unmatched.Count) {
  Write-Host ""
  Write-Host "=== Files whose Volume/Number could not be parsed ==="
  $mp3Idx.Unmatched    | ForEach-Object { Write-Host ("  MP3     : {0}" -f $_) }
  $transIdx.Unmatched  | ForEach-Object { Write-Host ("  Transcr : {0}" -f (Split-Path -Leaf $_)) }
  $exportIdx.Unmatched | ForEach-Object { Write-Host ("  Export  : {0}" -f (Split-Path -Leaf $_)) }
}
