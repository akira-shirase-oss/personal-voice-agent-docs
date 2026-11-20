# Personal Voice Agent Docs — agent instructions

The docs site for [personal-voice-agent](https://github.com/akira-shirase-oss/personal-voice-agent), built with
Astro Starlight and deployed to Cloudflare Pages as `docs.personal-voice-agent.404human.dev`. The product
repository is read-only reference for this worktree; never edit it from here.

The product is a **private, on-device** voice interface: no HTTP API, no hosted service, no accounts. The docs
never imply a network call exists; heard ≠ inferred ≠ executed is its core claim, so examples that pretend the
model spoke without a `tts_request`, or that consent is UI state rather than an on-disk token, are wrong.

## The model (same as the sibling docs sites)

- `src/content/docs/*.mdx` are the pages. Code fences carry test markers: `run=<suite>` executes,
  `output=<suite>` must match the real service (normalised), `not-run="why"` explains a block that
  cannot run (most app steps need a Mac with Apple Intelligence — mark them, don't fake them).
  `node scripts/snippets.mjs --coverage` fails on any unmarked block.
- The `session` suite runs `voice-session` built from the product's `main` (`PVA_DIR`, checked out
  by CI) and drives it over the protocol via `snippets/session.sh`'s helpers — its `output=` blocks
  show the service's real lines.
- `src/data/protocol.json` is generated from the product's `docs/PROTOCOL.md` by
  `scripts/gen-protocol.mjs` and kept bidirectionally in sync with the wire's golden lines
  (`fixtures/protocol/*.jsonl`) by `scripts/check-protocol.mjs` — the docs-rule "OpenAPI check"
  mapped onto the session protocol.
- `scripts/check.sh` is the gate before every push: node tests, check-urls, the protocol check,
  snippet coverage, `npm run build` (internal links, CSP hashes, Markdown twins), check-dist,
  check-privacy.

## Non-negotiables

- No secrets, real hostnames, home paths, user names, commit hashes or internal decision numbers
  (D-001 style) in anything committed (public repo). The only real hostname allowed is
  `docs.personal-voice-agent.404human.dev`. `scripts/check-dist.mjs` enforces most of this.
- Every example runs in CI or carries a `not-run` reason. Never fake an output block.
- No audio, transcripts, prompts or secrets in any committed file — the product's own log rule
  applies to its docs too.
- Neutral theme: Starlight tokens only, no product palette — a shared design system is coming.
- Small commits on `main`; the coordinator reviews and pushes.

## Verification

`scripts/check.sh` before every commit that touches pages, scripts or config; `npm run build`
before any commit, always.
