# Установка Ollama только на сервере Charitor (не на ПК пользователей).
# Запуск из корня проекта: .\scripts\setup-ollama.ps1

$ErrorActionPreference = "Stop"
$model = if ($env:OLLAMA_MODEL) { $env:OLLAMA_MODEL } else { "qwen2.5:3b" }

Write-Host "Charitor: проверка Ollama на этом компьютере (сервер)..." -ForegroundColor Cyan

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Host "Ollama не найдена. Скачайте установщик:" -ForegroundColor Yellow
  Write-Host "  https://ollama.com/download/windows" -ForegroundColor White
  Write-Host ""
  Write-Host "После установки перезапустите терминал и снова выполните этот скрипт." -ForegroundColor Yellow
  exit 1
}

Write-Host "Загрузка модели $model (один раз, ~2 ГБ для qwen2.5:3b)..." -ForegroundColor Cyan
ollama pull $model

Write-Host "Проверка API..." -ForegroundColor Cyan
$base = if ($env:OLLAMA_BASE_URL) { $env:OLLAMA_BASE_URL } else { "http://127.0.0.1:11434" }
try {
  $tags = Invoke-RestMethod -Uri "$base/api/tags" -Method Get -TimeoutSec 8
  $count = @($tags.models).Count
  Write-Host "OK: Ollama отвечает на $base, моделей в каталоге: $count" -ForegroundColor Green
} catch {
  Write-Host "Ollama установлена, но API не отвечает. Запустите в отдельном окне:" -ForegroundColor Yellow
  Write-Host "  ollama serve" -ForegroundColor White
  exit 1
}

Write-Host ""
Write-Host "В .env укажите:" -ForegroundColor Green
Write-Host "  BUILTIN_LLM_MODE=ollama" -ForegroundColor White
Write-Host "  OLLAMA_MODEL=$model" -ForegroundColor White
Write-Host ""
Write-Host "Перезапустите сервер: node config/server.js" -ForegroundColor Green
