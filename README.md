# Lunar Melee Clipper

A desktop app to automate clip generation from Slippi replays.

Compatible with Windows and Linux.

*In theory*, any video on the Lunar Melee channel can be made with this tool, with a small number of exceptions


## Pre-Requirements
- Slippi Dolphin

## Usage
- Import Slippi replays
- Filter replays by metadata
- Parse replays via a complex set of search tools
    - search for character-specific combos
        - example: "falcon stomp -> knee, fox upthrow -> upair, ken combos,"
    - search frame by frame using character action states, X/Y coordinates, etc...
- Generate __high quality__ video
    - Uses Dolphin's built-in frame by frame video/audio dump
    - Generates video at whatever video quality your computer can handle
        - You can run 24 concurrent instances of Slippi Dolphin and watch your computer melt :)

## Development version:

 - clone this repo
 - ```npm install```
 - ```npm run start```

To build, run ```./build.sh```


## Important contribution
See this repo for slp -> mp4 conversion:
https://github.com/kevinsung/slp-to-video
