---
name: plan-conference
description: Use research questions, topic meanings and individually identified presentations to plan learning.
version: 1.0.0
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
2. Use ontology_describe to select task definitions and inspect peer definitions before proposing correspondences. Preserve distinctions between schema, topics and report identity.
3. Use alignment_propose and alignment_accept only within disclosed task definitions. Reject a label-only Alignment equivalence; retain provenance/transparency as related and human review as a restricted form of user control.
4. Compare reports independently against each person's needs. Exchange only authorized selections using peer_send, then verify a mutually selected individual report with task_status.

## Verification

Check sources and versions in the returned records. Use task_status to distinguish drafts, pending decisions, confirmed receptions and executed operations. Describe partial completion or failure explicitly; a generated final message cannot replace a receipt.

