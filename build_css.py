#!/usr/bin/env python3
"""Baut die Mockup-Dateien: Design-Token + Basis-Komponenten + App-Styles in einer HTML-Datei,
Schriften als Data-URI eingebettet (kein CDN)."""
import base64, pathlib

base = pathlib.Path('/opt/data/workspace/hammerclassify/mockup')
read = pathlib.Path('/opt/data/cache/scratch/hlsw-read')
base.mkdir(exist_ok=True)

# Fonts als Data-URI
css = ['/* HLSW Fonts — lokal eingebettet (Data-URI), kein CDN. */\n']
fonts = [
    ('Inter', ['400', '500', '600', '700'], 'inter-latin-{}-normal.woff2'),
    ('Space Grotesk', ['600', '700'], 'space-grotesk-latin-{}-normal.woff2'),
    ('JetBrains Mono', ['400', '500'], 'jetbrains-mono-latin-{}-normal.woff2'),
]
for fam, weights, tmpl in fonts:
    for w in weights:
        raw = (read / tmpl.format(w)).read_bytes()
        b64 = base64.b64encode(raw).decode()
        sgn = 'normal'
        css.append(f"@font-face {{ font-family: '{fam}'; font-style: {sgn}; font-weight: {w}; "
                   f"font-display: swap; src: url(data:font/woff2;base64,{b64}) format('woff2'); }}\n")
(base / 'design-fonts.css').write_text(''.join(css))

# Tokens: Original aus hlsw-design-system + App-Akzent (Utility/Teal)
tokens = (read / 'hlsw-tokens.css').read_text()
tokens += """
/* --- HammerClassify: App-Akzent Utility (Teal) — wie die data-app-Blöcke im Designsystem --- */
[data-app="classify"] {
  --accent: #0F766E;
  --accent-hover: #0F766E;
  --accent-text: #0F766E;
  --accent-on: #FFFFFF;
  --accent-subtle: color-mix(in srgb, #0F766E 8%, #FFFFFF);
  --accent-border: color-mix(in srgb, #0F766E 28%, #FFFFFF);
  --focus-ring: color-mix(in srgb, #0F766E 55%, transparent);
}
:root[data-theme="dark"][data-app="classify"] {
  --accent: #2DD4BF;
  --accent-hover: #2DD4BF;
  --accent-text: #2DD4BF;
  --accent-on: #050D18;
  --accent-subtle: color-mix(in srgb, #2DD4BF 14%, transparent);
  --accent-border: color-mix(in srgb, #2DD4BF 34%, transparent);
  --focus-ring: color-mix(in srgb, #2DD4BF 60%, transparent);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"])[data-app="classify"] {
    --accent: #2DD4BF;
    --accent-hover: #2DD4BF;
    --accent-text: #2DD4BF;
    --accent-on: #050D18;
    --accent-subtle: color-mix(in srgb, #2DD4BF 14%, transparent);
    --accent-border: color-mix(in srgb, #2DD4BF 34%, transparent);
    --focus-ring: color-mix(in srgb, #2DD4BF 60%, transparent);
  }
}
"""
(base / 'design-tokens.css').write_text(tokens)
(base / 'hlsw-base.css').write_bytes((read / 'hlsw-base.css').read_bytes())
print('css ok', {p.name: p.stat().st_size for p in base.iterdir()})
