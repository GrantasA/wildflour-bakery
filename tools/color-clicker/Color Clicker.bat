@echo off
rem Double-click this file to start Color Clicker.
rem Keep it in the same folder as color_clicker_app.py.
cd /d "%~dp0"

set PY=
where py >nul 2>nul && set PY=py
if not defined PY (where python >nul 2>nul && set PY=python)
if not defined PY (
  echo Python is not installed. Get it from https://www.python.org/downloads/
  pause
  exit /b 1
)

%PY% -c "import pyautogui, PIL, numpy" >nul 2>nul
if errorlevel 1 (
  echo First run: installing what Color Clicker needs...
  %PY% -m pip install pyautogui pillow numpy
  if errorlevel 1 (
    echo Install failed. See the message above.
    pause
    exit /b 1
  )
)

rem pythonw runs it without a black console window.
set PYW=
where pythonw >nul 2>nul && set PYW=pythonw
if not defined PYW (where pyw >nul 2>nul && set PYW=pyw)
if defined PYW (
  start "" %PYW% color_clicker_app.py
) else (
  %PY% color_clicker_app.py
)
