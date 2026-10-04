@echo off
rem Start the motion worker for one family: run.bat hymotion
cd /d "%~dp0"
rem Weights go to ComfyUI's models folder, not the user-wide Hugging Face cache (the hf login stays where it is).
if "%HF_HUB_CACHE%"=="" set "HF_HUB_CACHE=%~dp0..\..\..\models\text_to_motion\hf_cache"
set FAMILY=%1
shift
"envs\%FAMILY%\Scripts\python.exe" worker.py --family %FAMILY% %1 %2 %3 %4
