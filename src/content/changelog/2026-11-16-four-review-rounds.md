---
title: Four review rounds harden the release line
date: 2026-11-16
type: Fix
areas: [Session service, Consent, Ledger, App]
docs:
  - { label: A turn, end to end, href: /a-turns-life/ }
  - { label: Consent and permissions, href: /consent-and-permissions/ }
---

Four independent review/fix rounds closed the worst of the first pass: lost revocations (a revoke
the service never read can never come back granted), silent drops of protocol messages and app
events, a leaked recognizer when a turn closed during capture, "Nothing has been done." never
spoken for a cut-off reply, model claims spoken as if true, deletion that was silent on failure,
stalled services never noticed, and test data directories left behind holding transcripts.
