---
name: coordinate-calendar
description: Find a mutually offered interval using only scoped availability and actual peer receipts.
version: 1.0.0
metadata:
  hermes:
    category: research
---

# Coordinate academic calendars

## When to use

Find a mutually offered interval using only scoped availability and actual peer receipts.

## Ontology and contract

- Modules: time.
- Inputs: TimeInterval.
- Outputs: AttendancePlan.
- Tools: `knowledge_search`, `authorization_check`, `peer_request`, `peer_send`, `task_status`.
- Effects: disclose-availability. Skill instructions do not themselves grant these effects.

## Procedure

1. Read your own offered Free intervals with knowledge_search. Treat absent events as unknown, not implicitly offered time.
2. Check authorization_check for the exact dates, fields, recipient and academic-coordination purpose before peer_send. Never send event titles or private notes as availability.
3. Use peer_request for the other agent's scoped availability. Base the intersection only on received records, then choose an interval containing the requested duration.
4. Report a mutually offered time. Do not claim a calendar invitation or room booking exists without the corresponding operation receipt.

## Verification

Check sources and versions in the returned records. Use task_status to distinguish drafts, pending decisions, confirmed receptions and executed operations. Describe partial completion or failure explicitly; a generated final message cannot replace a receipt.

