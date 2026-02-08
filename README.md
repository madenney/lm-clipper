# LM Clipper

A desktop app for automating high-quality clip generation from [Slippi](https://slippi.gg/) replays (Super Smash Bros. Melee).

## Features

- **Import** Slippi replay files (`.slp`) in bulk
- **Filter** replays by game metadata (characters, stages, dates, players)
- **Search** for specific combos using a powerful combo parser
  - Character-specific sequences (e.g. Falcon stomp -> knee, Fox upthrow -> upair)
  - Frame-by-frame search using action states, positions, and more
- **Generate high-quality video** using Slippi Dolphin's frame-by-frame dump + ffmpeg
  - Output at whatever resolution your hardware can handle
  - Run multiple concurrent Dolphin instances for batch processing
- **SQLite database** backend for fast filtering across large replay collections

## Download

Pre-built binaries are available on the [Releases](https://github.com/madenney/lm-clipper/releases) page.

Supported platforms: **Windows** and **Linux**.

## Prerequisites

- [Slippi Dolphin](https://slippi.gg/netplay) installed and configured
- A Melee ISO (NTSC 1.02)

## Build from Source

```bash
git clone https://github.com/madenney/lm-clipper.git
cd lm-clipper
npm install
npm run start
```

To create a production build:

```bash
npm run build
```

To package for distribution:

```bash
./build.sh
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for more details on development setup.

## Usage

1. Launch LM Clipper and configure the path to Slippi Dolphin
2. Import `.slp` replay files via drag-and-drop or the Import button
3. Apply filters to narrow down replays (characters, stages, date range, etc.)
4. Use the combo parser to search for specific combo sequences
5. Preview and select clips, then generate video

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and pull request guidelines.

## Acknowledgments

- [slp-to-video](https://github.com/kevinsung/slp-to-video) -- the foundation for Slippi replay to video conversion
- [electron-react-boilerplate](https://github.com/electron-react-boilerplate/electron-react-boilerplate) -- project template
- [Slippi](https://slippi.gg/) -- replay recording and Dolphin integration for Melee

## License

This project is licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE) for details.
