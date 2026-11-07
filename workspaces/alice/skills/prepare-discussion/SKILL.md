---
name: prepare-discussion
description: Prepare a sourced discussion agenda from own knowledge and actual received material, and explicitly deliver approved drafts when peer review is needed.
version: 2.0.2
metadata:
  hermes:
    category: research
---

# Prepare a research discussion

## When to use

Combine independently understood research questions and actually received materials into a useful agenda, with explicit and authorized handoffs between collaborators.

## Ontology and contract

- Modules: collaboration, materials.
- Inputs: ResearchQuestion, DocumentVersion.
- Outputs: DiscussionPlan, AgendaItem, DocumentVersion.
- Tools: `task_status`, `knowledge_search`, `artifact_prepare`, `artifact_revise`, `peer_request`, `authorization_check`, `authorization_request`, `peer_send`, `receipt_inspect`, `task_checkpoint`.
- Effects: write-local-draft, request-peer-input, disclose-material, request-owner-decision. Skill instructions do not grant disclosure or booking permission.

## Procedure

1. Read task_status for the owner's goal, agreed report and time, actual received messages, current artifacts and checkpoint. Reuse decisions already supported by this audience's records; do not repeat earlier ontology work unless new information requires it.
2. Use targeted knowledge_search to retrieve your own relevant questions, evidence or material. Request needed collaborator input through peer_request. A request asks for cooperation only: pending or unsent material has not arrived, and a message mentioning an artifact ID does not grant access to that artifact.
3. Prepare an agenda with artifact_prepare and revise it with artifact_revise as actual input arrives. Cite real own source records and actual received message or receipt IDs in sourceRefs. Represent the collaborator's contribution only from information actually received. An agenda is a local artifact; creating it does not publish or share it.
4. If the collaborator needs to review a draft, check authorization for peer_send of your own artifact's exact version and selected fields. If approval is required, request that exact disclosure, checkpoint needs_owner and end this run. After approval, use the approved fields, call peer_send and inspect its delivery receipt. peer_request with agenda_review may ask for a review but does not attach, send or expose a private draft.
5. Request additional private context only when it is needed for the owner's goal. Continue with the approved subset or available public alternatives after refusal. Preserve the recipient and scope the owner actually decided; do not turn a permission question into repeated probes for a larger disclosure.
6. For venue coordination, read the task's execution.reservationOrganizer and hand off actual approved information to that role as needed. A received draft remains message data in the recipient's workspace; that role must create its own executable reservation form before any booking operation.
7. When awaiting a partner review or booking result, save task_checkpoint waiting_peer and end the run. Use task_status and receipt_inspect on continuation. Complete a local drafting goal once its sourced artifact is saved; a joint goal that includes delivery or booking still needs the corresponding actual receipts.

## Verification

Saving an agenda, delivering it, obtaining an owner's decision and receiving a booking confirmation are separate states. Do not write unrelated KG facts through knowledge_record just to make an agenda count as delivered or to manufacture task progress. The relevant evidence is the sourced artifact and, when requested, its real peer_send receipt.

Verify that draft contents reflect actually available information, references resolve to own or genuinely received records, and any peer review was enabled by an explicit authorized send. Describe pending review, refusal or partial preparation accurately; a final generated message cannot replace the required delivery or operation receipt.

