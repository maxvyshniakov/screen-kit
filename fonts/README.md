Noto Sans Symbols 2 supplies the legacy-computing slot glyph (U+1FB85) for screenshot export.
Bundled under the SIL Open Font License in `OFL.txt`.

Source: https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf/NotoSansSymbols2
JetBrains Mono 2.304 supplies regular and bold text, matching Ghostty's default font.
It is bundled under the SIL Open Font License in `JetBrainsMono-OFL.txt`.
Source: https://github.com/JetBrains/JetBrainsMono/tree/v2.304/fonts/ttf

The exporter explicitly selects JetBrains Mono for text and Noto Sans Symbols 2 for missing symbols.

ScreenKitMono-{Regular,Bold}.ttf are derivatives of JetBrains Mono 2.304 under the
same SIL Open Font License (`JetBrainsMono-OFL.txt`), renamed to Screen Kit Mono.
Only U+25A0 is changed: 5% side bearings keep compact bar cells visibly separate,
as in Ghostty's terminal symbol rendering. All text, bold faces, box drawing and
block elements retain the original geometry. Select `Screen Kit Mono` in a recipe
to use this variant. Rebuild with
`uv run --with fonttools python tools/build-symbol-font.py`.
