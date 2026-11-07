---
name: share-materials
description: Prepare an exact versioned projection, obtain current permission and send only approved fields.
version: 2.0.0
metadata:
  hermes:
    category: research
---

# Share selected research materials

## When to use

Prepare an exact versioned projection, obtain current permission and send only approved fields.

## Ontology and contract

- Modules: materials.
- Inputs: DocumentVersion.
- Outputs: SelectedExcerpt.
- Tools: `artifact_prepare`, `authorization_check`, `authorization_request`, `peer_send`, `task_checkpoint`, `task_status`.
- Effects: disclose-material. Skill instructions do not themselves grant these effects.

## Procedure

1. Identify the source material and immutable version using knowledge_search. Prepare only the necessary fields using artifact_prepare.
2. Call authorization_check with the exact recipient, purpose, task, source references and content. KG authorization summaries locate rules but are not executable authority.
3. If permission is missing, call authorization_request. Explain the benefit of each optional field and allow the owner to narrow the projection; then checkpoint and stop.
4. After the decision, inspect current task state and send only the approved version through peer_send. A new source version, field, recipient or purpose requires another check.
5. Verify actual reception using task_status. A queued send or approval alone does not prove delivery; rewriting private material does not make it public.

## Verification

Check sources and versions in the returned records. Use task_status to distinguish drafts, pending decisions, confirmed receptions and executed operations. Describe partial completion or failure explicitly; a generated final message cannot replace a receipt.

