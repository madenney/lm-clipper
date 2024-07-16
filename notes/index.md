
# Instructions for packaging sqlite binaries

sqlite download:
https://www.sqlite.org/download.html

Download binaries for linux + windows 
- for windows the sqlite3.exe file is in the tools for some reason

Put them into "/lm-clipper/release/app/sqlite/"

Final file paths should be:
- lm-clipper/release/app/sqlite3/sqlite3.exe
- lm-clipper/release/app/sqlite3/sqlite3



# Instructions for packaging ffmpeg binaries

Clone this repo 
https://github.com/eugeneware/ffmpeg-static.git

- cd ffmpeg-static
- npm install
- ./download-binaries/index.sh

^ That should create a "bin" folder which will contain the binaries.


You need two files:
- ffmpeg-win32-x64.exe
- ffmpeg-linux-x64

Put them into "/lm-clipper/release/app/ffmpeg/"

Final file paths should be:
- lm-clipper/release/app/ffmpeg/ffmpeg-win32-x64.exe
- lm-clipper/release/app/ffmpeg/ffmpeg-linux-x64
