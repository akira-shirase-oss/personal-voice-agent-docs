# Personal Voice Agent — documentation

The docs site for [personal-voice-agent](https://github.com/akira-shirase-oss/personal-voice-agent),
built with Astro Starlight and deployed to Cloudflare Pages.

## Working on it

- `npm run dev` — local preview.
- `scripts/check.sh` — the gate before every push: unit tests, `check-urls`, the protocol check,
  snippet coverage, `npm run build` (links, CSP hashes, Markdown twins), `check-dist`,
  `check-privacy`.
- `PVA_DIR` points at a product checkout (default `../personal-voice-agent`); CI makes one.
- `npm run protocol` regenerates `src/data/protocol.json` from the product's `docs/PROTOCOL.md`;
  `npm run check:protocol` verifies it both ways against `fixtures/protocol/*.jsonl`.
- `npm run snippets` runs every `run=` block for real — the session suite builds `voice-session`
  from `PVA_DIR` and drives it over the protocol; `output=` blocks must match its answers.
  `--update` rewrites outputs, `--coverage` fails on any unmarked block.
