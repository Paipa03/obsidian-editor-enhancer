# Editor Enhancer

Editor enhancements for Live Preview. Every feature group can be switched on or off on its own in the plugin settings.

## Features

- **Notion-style blocks**: a six-dot handle beside each block for dragging blocks around, a plus slot for inserting a new block, and a block menu.
- **Toggle lists**: collapsible sections stored as plain Markdown comments (`%% nsb-toggle {...} %%` … `%% /nsb-toggle %%`), so notes stay readable without the plugin. Toggle lists can be nested.
- **List markers as one unit**: the bullet / number / checkbox prefix of a list line behaves as a single unit for the caret, Backspace and Delete.
- **Context-menu polish**: right-click no longer selects the whole line, and related menu items are grouped.
- **Scroll memory**: returning to a note restores where you were.
- **Mobile table links**: tapping a link inside a table on mobile opens it.
- Spacing and icon appearance settings for blocks and toggles.

## Works with

[Expiring Blocks](https://github.com/Paipa03/obsidian-expiring-blocks), Paipa Gallery, Section Blocks and Web Bookmark plug into the block handle and menu when they are installed. None of them is required.

## Install

Settings → Community plugins → Browse → search **Editor Enhancer**.

Manual: download `main.js`, `manifest.json` and `styles.css` (if present) from the latest release into `<vault>/.obsidian/plugins/editor-enhancer/`.

## Notes

- Settings labels are currently in Chinese.
- Desktop and mobile.

## License

MIT
