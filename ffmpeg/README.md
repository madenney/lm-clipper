
# Instructions on packaging ffmpeg binaries

Clone this repo in a /sandbox

https://github.com/eugeneware/ffmpeg-static.git


Just 'npm install' and then run './download-binaries/index.sh'

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
