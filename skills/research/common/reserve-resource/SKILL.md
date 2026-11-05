---
name: reserve-resource
description: Match requirements to rooms, prepare an exact booking and execute only with independently checked permission.
version: 1.0.0
metadata:
  hermes:
    category: research
---

# Coordinate rooms and resources

## When to use

Match requirements to rooms, prepare an exact booking and execute only with independently checked permission.

## Ontology and contract

- Modules: collaboration.
- Inputs: VenueRequirement.
- Outputs: ReservationProposal, ConfirmedReservation.
- Tools: `resource_search`, `artifact_prepare`, `authorization_check`, `authorization_request`, `reservation_submit`, `task_status`.
- Effects: reserve-resource. Skill instructions do not themselves grant these effects.

## Procedure

1. Read the actual discussion requirements: time, capacity, equipment and agreed public booking description.
2. Call resource_search and compare candidates against every required condition, including the precise day and interval.
3. Prepare the exact ReservationProposal using artifact_prepare. Keep private research excerpts out of the booking form unless separately authorized for the booking service.
4. Call authorization_check/request for reservation_submit with the final form and destination. Yield until the owner's decision is recorded.
5. Submit using a stable operation ID and inspect the actual booking receipt. If the response is uncertain, query the existing operation instead of creating another booking.

## Verification

Reservation draft fields are `title`, `day`, `time`, `attendees`, and `agenda`, all text. Use e.g. `day: "Thu"`, `time: "15:00–15:30"`, `attendees: "8"`; the service validates this form before requesting approval. A field named `meeting` is not a replacement for `day` and `time`. Match the selected room's actual time and capacity, then use the same artifact ID and venue ID for authorization and submission.

Check sources and versions in the returned records. Use task_status to distinguish drafts, pending decisions, confirmed receptions and executed operations. Describe partial completion or failure explicitly; a generated final message cannot replace a receipt.

