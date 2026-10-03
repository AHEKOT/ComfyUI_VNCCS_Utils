@echo off
rem Create the isolated environment for one motion model family: install.bat ardy
rem Nothing is installed into ComfyUIs Python.
setlocal
cd /d "%~dp0"
set FAMILY=%1
if not exist "requirements\%FAMILY%.txt" (echo usage: install.bat ardy^|kimodo^|hymotion^|unimate & exit /b 1)
if "%PYTHON%"=="" set PYTHON=python
if "%TORCH_INDEX%"=="" set TORCH_INDEX=https://download.pytorch.org/whl/cu126
%PYTHON% -m venv "envs\%FAMILY%" || exit /b 1
set ENV_PY=envs\%FAMILY%\Scripts\python.exe
%ENV_PY% -m pip install --upgrade pip "setuptools<81" wheel || exit /b 1
%ENV_PY% -m pip install torch --index-url %TORCH_INDEX% || exit /b 1
%ENV_PY% -m pip install --no-build-isolation -r "requirements\%FAMILY%.txt" || exit /b 1
echo Done. Start the worker with: run.bat %FAMILY%
