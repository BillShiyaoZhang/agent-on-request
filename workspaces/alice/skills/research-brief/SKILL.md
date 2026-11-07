---
name: research-brief
description: Prepare a concise account of research questions, methods, evidence and limitations from explicit source versions.
version: 2.0.0
metadata:
  hermes:
    category: research
---

# Prepare a sourced research brief

## When to use

Prepare a concise account of research questions, methods, evidence and limitations from explicit source versions.

## Ontology and contract

- Modules: evidence, materials.
- Inputs: ResearchProject, DocumentVersion.
- Outputs: DocumentVersion, SelectedExcerpt.
- Tools: `knowledge_search`, `artifact_prepare`, `artifact_revise`, `authorization_check`, `authorization_request`, `knowledge_record`.
- Effects: write-local-draft, request-owner-decision, write-private-knowledge. Skill instructions do not themselves grant these effects.

## Procedure

Use knowledge_record when the owner asks to maintain research memory: submit typed private nodes and relations with source references. This updates only the current identity workspace and cannot certify public content or create authorization.

1. Retrieve the relevant research question, manuscript version, experiment and evidence using knowledge_search.
2. Use artifact_prepare to distinguish the question, method, measured results and limitations; retain the exact source version for every excerpt.
3. Keep unpublished numbers and internal notes visible in the local draft rather than silently treating them as public.
4. Call authorization_check/request before any intended disclosure. A brief may be narrowed to a method summary without its results.

## Verification

Check sources and versions in the returned records. Use task_status to distinguish drafts, pending decisions, confirmed receptions and executed operations. Describe partial completion or failure explicitly; a generated final message cannot replace a receipt.

