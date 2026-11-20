---
title: The million-scale runs pass on CI
date: 2026-11-20
type: Improvement
areas: [Performance, Ledger, Session service]
docs:
  - { label: Reliability and recovery, href: /operating/reliability/ }
---

Both owed load scenarios now run on demand in CI: 1,000,000 durable ledger appends (p99 7.72 ms
against the 50 ms budget) and a 1,000,000-event turn run with an interruption every 10 events and
a stall every 100 (reply p99 0.41 ms, every expected late result dropped, zero unexpected
degradations). Results are committed with machine, commit and load average — Linux-labelled, since
Linux fsync differs from macOS.
