@echo off
cd /d "%~dp0"
echo Paigaldan paketid ja laen alla Ollama mudelid (kokku umbes 6 GB).
echo Enne peavad olemas olema Node.js ja Ollama.
echo.
call npm install
ollama pull bge-m3
ollama pull hf.co/mradermacher/Llama-3.1-EstLLM-8B-Instruct-1125-i1-GGUF:Q4_K_M
echo.
echo Valmis. Vestluse avab start.bat
pause
