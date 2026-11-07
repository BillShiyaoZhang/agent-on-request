---
name: plan-conference
description: Use research questions, topic meanings and individually identified presentations to plan learning.
version: 2.0.0
metadata:
  hermes:
    category: research
---

# Plan conference attendance

## When to use

Use research questions, topic meanings and individually identified presentations to plan learning.

## Ontology and contract

- Modules: research.
- Inputs: ResearchQuestion, Conference.
- Outputs: AttendancePlan.
- Tools: `knowledge_search`, `ontology_describe`, `alignment_propose`, `alignment_accept`, `peer_send`, `task_status`.
- Effects: disclose-working-ontology, disclose-report-selection. Skill instructions do not themselves grant these effects.

## Procedure

1. Read the current research questions and interests with knowledge_search, then inspect the actual conference report records and their stable conference/report IDs.
2. Use ontology_describe to inspect your own definitions. Ask the collaborator to explain relevant terms and only use definitions actually received through communication. Keep their original expressions and source references.
3. Compare actually disclosed meanings, scope and evidence. Propose correspondences with a relation and conditions; ask the collaborator to review them. Matching words alone do not establish equivalent meaning. Keep equivalent, related, broader, narrower and incompatible meanings distinct as the evidence requires.
4. Compare reports independently against each person's needs. Exchange only authorized selections using peer_send, then verify a mutually selected individual report with task_status.

## Verification

Check sources and versions in the returned records. Use task_status to distinguish drafts, pending decisions, confirmed receptions and executed operations. Describe partial completion or failure explicitly; a generated final message cannot replace a receipt.

