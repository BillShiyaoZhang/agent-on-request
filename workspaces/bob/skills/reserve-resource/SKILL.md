---
name: reserve-resource
description: Coordinate a suitable resource, hand off approved drafts, and let the task's designated organizer submit an independently authorized local form.
version: 2.0.2
metadata:
  hermes:
    category: research
---

# Coordinate rooms and resources

## When to use

Find a suitable resource and coordinate its booking while preserving the task's execution role, exact authorization scope and actual receipts.

## Ontology and contract

- Modules: collaboration, materials.
- Inputs: VenueRequirement, DocumentVersion.
- Outputs: ReservationProposal, ConfirmedReservation.
- Tools: `task_status`, `resource_search`, `artifact_prepare`, `artifact_revise`, `authorization_check`, `authorization_request`, `peer_send`, `receipt_inspect`, `reservation_submit`, `task_checkpoint`.
- Effects: write-local-draft, disclose-material, request-owner-decision, reserve-resource. Skill instructions do not grant these effects or change the designated execution role.

## Procedure

1. Read task_status and its execution.reservationOrganizer before planning submission. Use this task-provided role rather than guessing from a name, professional field or peer claim. If no submitting organizer is specified, clarify the task and save progress; do not attempt reservation_submit.
2. Read the actual requested time, capacity, equipment and permitted booking description from task state, your own records and messages actually received. Use resource_search to compare available venues against those requirements. Do not substitute a fixture time or assume a draft implies availability.
3. Prepare or revise your own sourced draft with artifact_prepare or artifact_revise. Record the actual source IDs in sourceRefs. Keep private research excerpts out of the booking form unless their inclusion is specifically authorized for its recipient.

### When you are not the submitting organizer

4. Contribute a useful local draft or resource suggestion. If the organizer needs its contents, check permission for peer_send of your own artifact's exact version and selected fields. Request a bounded owner decision only when required; checkpoint needs_owner and end the run while that decision is pending.
5. Send only the approved draft fields through peer_send and inspect the actual delivery receipt. A local save, a cooperation request or the organizer knowing an artifact ID does not give that agent access to the private draft.
6. After handoff, checkpoint waiting_peer and wait for the organizer's actual response or booking receipt. Do not call reservation_submit or seek permission to submit in place of the designated organizer. A disclosure grant and a draft delivery receipt are not booking confirmation.

### When you are the submitting organizer

4. Treat a collaborator's delivered draft as received message data. Its resourceId identifies the collaborator's source; it is not an artifact you own and cannot be submitted directly.
5. Read the actual received fields, create a new local artifact with kind "reservation", and cite the real received message or receipt ID in sourceRefs. Use the local form returned by artifact_prepare for subsequent checks. If required values are missing, obtain the missing information rather than submitting a peer-owned artifact or inventing values.
6. Check authorization for reservation.submit using the final local artifact ID and selected venue ID. Request the owner's separate decision on the complete form when required, checkpoint needs_owner and end the run. Material sharing or draft review does not approve the booking.
7. After the decision, retrieve current state and authorization, then submit the same approved local form and venue through reservation_submit. Inspect the actual receipt. When an operation is uncertain, query the existing receipt or operation first; do not create another booking to work around uncertainty.

## Verification

The local reservation adapter requires title, day, time, attendees and agenda. Follow the actual tool's declared field types and returned validation errors; attendees is a participant count, not a list of names. Use the actual requested interval and selected venue conditions. Verify that your form is owned by this agent, cites any peer input through its real received reference, and matches the version and destination the owner reviewed.

Use receipt_inspect and task_status to distinguish preparation, approved disclosure, draft delivery, booking permission and confirmed execution. Report only the state supported by actual records. A non-organizer's completed contribution does not prove the organizer submitted a booking.

