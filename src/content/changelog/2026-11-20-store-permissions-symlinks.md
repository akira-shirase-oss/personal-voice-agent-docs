---
title: Existing stores tightened at open; no store file is ever a followed link
date: 2026-11-20
type: Security
areas: [Store, Consent, Session service]
docs:
  - { label: The data directory, href: /operating/data-directory/ }
---

A data directory or file created before the permission rules landed kept its loose mode forever —
`0700`/`0600` only applied at creation. Open now strips group/other bits from every store entry —
only ever removing, never granting — and syncs the change. And no store file is opened through a
symlink: `consent.log`, session logs, the lock and the consent tokens are opened without following
links, so a link planted at a store path fails closed instead of writing outside the data
directory. A planted subdirectory inside `ledger/` is refused outright.
