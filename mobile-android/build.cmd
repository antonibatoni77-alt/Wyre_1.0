@echo off
rem Сборка APK Wyre для Android.
rem Требует: JDK 17, Android SDK в D:\wyre\android-sdk, Gradle в D:\wyre\android-tools\gradle-8.9.
setlocal
set "JAVA_HOME=C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot"
set "GRADLE_HOME=D:\wyre\android-tools\gradle-8.9"
call "%GRADLE_HOME%\bin\gradle.bat" assembleRelease --no-daemon
if errorlevel 1 exit /b 1
copy /y "app\build\outputs\apk\release\app-release.apk" "dist\Wyre-1.0.0.apk" >nul
echo Готово: dist\Wyre-1.0.0.apk
endlocal
