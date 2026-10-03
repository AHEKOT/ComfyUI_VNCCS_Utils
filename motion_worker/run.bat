@echo off
rem Start the motion worker for one family: run.bat ardy
cd /d "%~dp0"
set FAMILY=%1
shift
"envs\%FAMILY%\Scripts\python.exe" worker.py --family %FAMILY% %1 %2 %3 %4
