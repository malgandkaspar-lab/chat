@echo off
cd /d "%~dp0"
echo Laen alla uued lehed ja uuendan otsinguindeksit. Esimene kord votab mitu tundi.
node ingest.js
pause
