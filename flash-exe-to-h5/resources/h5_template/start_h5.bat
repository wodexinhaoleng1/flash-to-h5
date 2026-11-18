@echo off
cd /d "%~dp0"
echo Starting local HTTP server for H5 at http://localhost:8080/index.html ...
start "" http://localhost:8080/index.html
python server.py 8080
pause
