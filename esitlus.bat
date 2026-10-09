@echo off
cd /d "%~dp0"
echo Avan naidise: Keskkonnaportaali metsaleht koos vestluskastiga.
echo Leht tootab ainult selles arvutis, kuni see aken on lahti.
node server.js --cloud --portaal --open
pause
