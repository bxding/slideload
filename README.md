# slideload

Turn a web/HTML slide deck into a PDF.
One page per slide and build step, so animations are captured as they play.

Works with reveal.js decks directly, and with anything else that
advances on a key press (Slidev, remark, impress.js, …) by pressing the key until the
screen stops changing.

No dependencies! It drives the existing Chromium you already have.

## Requirements

- [Bun](https://bun.sh/) or [Node 22+](https://nodejs.org/en/download)
- Chromium browser: Brave, Chrome, Chromium, or Edge installeds

## Usage

Bun:

```sh
bun src/cli.js https://example.edu/slides/week1
bun link            # optional: installs the `slideload` and `sl` commands
sl <url>
```

`bun link` puts the commands in `~/.bun/bin`. If `sl` isn't found, add it to your PATH:

```sh
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

Node:

```sh
node src/cli.js https://example.edu/slides/week1
npm link            # optional: installs the `slideload` and `sl` commands
sl <url>
```

Output goes to `<last url segment>.pdf` in the current directory.

## Options

| Flag | Meaning |
|---|---|
| `-o, --out <file>` | output path (default `<deck-name>.pdf`) |
| `--final` | one page per slide (last build step only) |
| `--notes` | also write `<out>.notes.md` with speaker notes, if the deck exposes them |
| `--driver <name>` | force `studio`, `reveal`, or `keys` (default: auto-detect) |
| `--key <name>` | key the `keys` driver presses (default `ArrowRight`; e.g. `Space`, `PageDown`) |
| `--settle <ms>` | wait after each move before capturing |
| `--max-pages <n>` | safety cap, default 500 |
| `--raster` | screenshot pages (JPEG) instead of vector; use if a deck prints badly |
| `--quality <1-100>` | JPEG quality for `--raster`, default 90 |
| `--scale <n>` | device scale for `--raster`, `2` = retina, default 1 |
| `--headed` | show the browser window |
| `--browser <path>` | browser executable (default: Brave, then Chrome/Chromium/Edge) |
| `--profile <dir>` | browser profile dir (default `~/.slideload/profile`) |
| `--timeout <ms>` | wait for a known framework before falling back, default 15000 |

## Deck behind a login?

Run with `--headed`, log in in the window that opens, then press Enter in the terminal.
The login is saved in `~/.slideload/profile` for next time. (Your normal Brave profile
can't be used: Chromium blocks automation on the default profile since v136.)

## Deck not detected?

The `keys` fallback presses `ArrowRight` and stops after three presses that change
neither the screen nor the URL. If the deck uses another key or animates slowly, try
`--key Space` or `--settle 1000`. Autoplaying video or looping animation looks like a
change and produces extra pages; `--max-pages` bounds it.

## License

GPL-3.0. See `LICENSE`.
