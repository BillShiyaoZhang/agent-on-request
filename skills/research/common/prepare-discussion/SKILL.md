---
name: prepare-discussion
description: Combine independently understood research questions and actually received materials into a sourced agenda.
version: 1.0.0
metadata:
  hermes:
    category: research
---

# Prepare a research discussion

## When to use

Combine independently understood research questions and actually received materials into a sourced agenda.

## Ontology and contract

- Modules: collaboration.
- Inputs: ResearchQuestion, DocumentVersion.
- Outputs: DiscussionPlan, AgendaItem.
- Tools: `knowledge_search`, `artifact_prepare`, `artifact_revise`, `peer_request`, `task_checkpoint`, `task_status`.
- Effects: write-local-draft. Skill instructions do not themselves grant these effects.

## Procedure

1. Retrieve the agreed report and time through task_status; do not redo earlier choices unless their inputs changed.
2. Use knowledge_search to retrieve your own research questions and permitted materials. Request specific partner input with peer_request; never assume pending content has arrived.
3. Create a sourced DiscussionPlan and AgendaItems using artifact_prepare. Include complementary questions from both domains and revise using actually received material.
4. When additional private context is useful, prepare its exact version and call authorization_check/request. Save task_checkpoint and yield while a human decision is pending.
5. Continue with the approved subset or public alternatives after refusal. Keep the agenda draft, resource proposal and confirmed reservation as distinct states.

## Verification

Check sources and versions in the returned records. Use task_status to distinguish drafts, pending decisions, confirmed receptions and executed operations. Describe partial completion or failure explicitly; a generated final message cannot replace a receipt.

