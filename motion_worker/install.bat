@echo off
rem Create the isolated venv for one motion model family: install.bat hymotion
rem Nothing goes into ComfyUIs Python. Works with ComfyUI portable: its embedded Python is not used.
rem Uses uv when installed (it downloads Python 3.11 itself, like ComfyUI Desktop), else a system Python.
setlocal
cd /d "%~dp0"
set FAMILY=%1
if not exist "requirements\%FAMILY%.txt" (echo usage: install.bat hymotion^|unimate & exit /b 1)
if "%TORCH_INDEX%"=="" set TORCH_INDEX=https://download.pytorch.org/whl/cu126
if "%PYTHON_VERSION%"=="" set PYTHON_VERSION=3.11
set ENV=envs\%FAMILY%
set ENV_PY=%ENV%\Scripts\python.exe
rem cmake comes from pip into the venv (some model packages build C++ extensions); its Scripts folder must be on PATH.
set "PATH=%CD%\%ENV%\Scripts;%PATH%"
where uv >nul 2>nul
if %errorlevel%==0 goto :uv
if "%PYTHON%"=="" set PYTHON=py -%PYTHON_VERSION%
%PYTHON% -c "import venv" >nul 2>nul
if errorlevel 1 (
  echo No usable Python found. Install uv ^(it brings its own Python^), then run this again:
  echo   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  exit /b 1
)
%PYTHON% -m venv "%ENV%" || exit /b 1
%ENV_PY% -m pip install --upgrade pip "setuptools<81" wheel cmake || exit /b 1
%ENV_PY% -m pip install torch --index-url %TORCH_INDEX% || exit /b 1
%ENV_PY% -m pip install --no-build-isolation -r "requirements\%FAMILY%.txt" || exit /b 1
goto :done
:uv
uv venv --python %PYTHON_VERSION% --seed "%ENV%" || exit /b 1
uv pip install --python "%ENV_PY%" "setuptools<81" wheel cmake || exit /b 1
uv pip install --python "%ENV_PY%" torch --index-url %TORCH_INDEX% || exit /b 1
uv pip install --python "%ENV_PY%" --no-build-isolation -r "requirements\%FAMILY%.txt" || exit /b 1
:done
echo Done. Start the worker with: motion_worker\run.bat %FAMILY%
