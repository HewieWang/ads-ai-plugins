$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$installDir = Join-Path $env:LOCALAPPDATA "Adsmarch"

function Ask-YesNo {
  param([string]$Prompt, [bool]$Default = $false)
  $suffix = "[y/N]"
  if ($Default) { $suffix = "[Y/n]" }
  while ($true) {
    $answer = Read-Host "$Prompt $suffix"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    switch ($answer.Trim().ToLowerInvariant()) {
      "y" { return $true }
      "yes" { return $true }
      "n" { return $false }
      "no" { return $false }
      default { Write-Host "请输入 y 或 n。" -ForegroundColor Yellow }
    }
  }
}

Write-Host ""
Write-Host "  Adsmarch 卸载程序" -ForegroundColor Cyan
Write-Host "  安装目录：$installDir"
Write-Host ""

$answer = Read-Host "输入 YES 确认卸载"
if ($answer -ne "YES") {
  Write-Host "已取消。" -ForegroundColor Yellow
  exit 0
}

$keepData = Ask-YesNo "是否保留已连接账户、加密密钥和审计数据？" $false

Write-Host ""
Write-Host "==> 停止 Adsmarch 进程" -ForegroundColor Cyan
try {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($installDir) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {}

Write-Host "==> 删除快捷方式" -ForegroundColor Cyan
$desktop = [Environment]::GetFolderPath("Desktop")
$startup = [Environment]::GetFolderPath("Startup")
$targets = @(
  (Join-Path $desktop "打开 Adsmarch 管理台.url"),
  (Join-Path $desktop "与 Codex 对话.cmd"),
  (Join-Path $startup "Adsmarch 管理台.lnk")
)
foreach ($target in $targets) {
  if (Test-Path $target) { Remove-Item -Force $target -ErrorAction SilentlyContinue }
}

Write-Host "==> 移除 Codex MCP 配置" -ForegroundColor Cyan
$codexConfig = Join-Path (Join-Path $env:USERPROFILE ".codex") "config.toml"
if (Test-Path $codexConfig) {
  $content = [IO.File]::ReadAllText($codexConfig, [Text.Encoding]::UTF8)
  if ($content -match '(?m)^\[mcp_servers\.adsmarch\]') {
    Copy-Item $codexConfig ($codexConfig + ".bak-" + (Get-Date -Format "yyyyMMddHHmmss")) -Force
    $pattern = '(?ms)^\[mcp_servers\.adsmarch\]\r?\n.*?(?=^\[|\z)'
    $updated = [regex]::Replace($content, $pattern, "")
    [IO.File]::WriteAllText($codexConfig, $updated.TrimEnd() + "`r`n", (New-Object Text.UTF8Encoding($false)))
    Write-Host "  已从 Codex 配置中移除 adsmarch。"
  }
}

if ($keepData -and (Test-Path $installDir)) {
  $backup = Join-Path $env:LOCALAPPDATA ("Adsmarch-backup-" + (Get-Date -Format "yyyyMMddHHmmss"))
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  if (Test-Path (Join-Path $installDir "data")) {
    Move-Item -Path (Join-Path $installDir "data") -Destination (Join-Path $backup "data")
  }
  if (Test-Path (Join-Path $installDir ".env")) {
    Move-Item -Path (Join-Path $installDir ".env") -Destination (Join-Path $backup ".env")
  }
  Write-Host "  数据已备份到：$backup" -ForegroundColor Green
}

Write-Host "==> 删除安装目录" -ForegroundColor Cyan
Set-Location $env:TEMP
if (Test-Path $installDir) {
  Remove-Item -Recurse -Force $installDir -ErrorAction SilentlyContinue
  if (Test-Path $installDir) {
    Write-Host "  部分文件未能删除，请重启电脑后手动删除：$installDir" -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "  Adsmarch 已卸载。" -ForegroundColor Green
Write-Host "  请记得到 Google / Meta / TikTok 后台撤销本应用的 OAuth 授权。" -ForegroundColor Yellow
Write-Host ""
