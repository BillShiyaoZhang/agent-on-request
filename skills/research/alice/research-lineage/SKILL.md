---
name: research-lineage
description: Connect papers, notes, methods and datasets to research questions while preserving source and version evidence.
version: 1.0.0
metadata:
  hermes:
    category: research
---

# Maintain research and literature lineage

## When to use

Connect papers, notes, methods and datasets to research questions while preserving source and version evidence.

## Ontology and contract

- Modules: research, semantics.
- Inputs: ResearchQuestion, Paper.
- Outputs: ResearchNote, ReadingPlan.
- Tools: `knowledge_search`, `artifact_prepare`, `artifact_revise`, `knowledge_record`.
- Effects: write-local-draft, write-private-knowledge. Skill instructions do not themselves grant these effects.

## Procedure

Use knowledge_record when the owner asks to maintain research memory: submit typed private nodes and relations with source references. This updates only the current identity workspace and cannot certify public content or create authorization.

1. Use knowledge_search to trace a research question to its project, topics, papers, notes and source versions.
2. Keep the research artifact, its version, and the underlying application-ontology definition distinct.
3. Prepare a literature or ReadingPlan draft with artifact_prepare, retaining stable source IDs and explicit evidence gaps.
4. Revise through artifact_revise if requested. Local organization does not authorize sending the resulting note.

## Verification

Check sources and versions in the returned records. Use task_status to distinguish drafts, pending decisions, confirmed receptions and executed operations. Describe partial completion or failure explicitly; a generated final message cannot replace a receipt.

