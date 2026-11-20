---
title: "The first release: capture to reply, consent to close"
date: 2026-11-16
type: Feature
areas: [App, Session service, Protocol, Ledger, Consent]
docs:
  - { label: Concepts, href: /concepts/ }
  - { label: Protocol reference, href: /api/reference/ }
---

The V0–V2 release line landed: a SwiftUI app hosting Apple's on-device Speech, FoundationModels
and the system voice, driving a Rust `voice-session` child over JSON-lines stdin/stdout. The
service owns consent, provider deadlines, interruption with a playback fence, the checksummed
append-only ledger, confirmation against the preserved transcript, and a fail-closed store — no
audio retained, nothing external authorized, everything local.
