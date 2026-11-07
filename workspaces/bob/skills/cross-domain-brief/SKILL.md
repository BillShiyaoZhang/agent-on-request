---
name: cross-domain-brief
description: Translate HCI research into partner-facing questions and design suggestions without equating unrelated domain terms.
version: 2.0.0
metadata:
  hermes:
    category: research
---

# Prepare cross-domain collaboration briefs

## When to use

Translate HCI research into partner-facing questions and design suggestions without equating unrelated domain terms.

## Ontology and contract

- Modules: findings, materials.
- Inputs: ResearchQuestion, Finding.
- Outputs: DiscussionPlan, DocumentVersion.
- Tools: `knowledge_search`, `ontology_describe`, `artifact_prepare`, `authorization_check`, `authorization_request`, `knowledge_record`.
- Effects: write-local-draft, request-owner-decision, write-private-knowledge. Skill instructions do not themselves grant these effects.

## Procedure

Use knowledge_record when the owner asks to maintain research memory: submit typed private nodes and relations with source references. This updates only the current identity workspace and cannot certify public content or create authorization.

1. Retrieve HCI questions, findings, observations and relevant design alternatives using knowledge_search.
2. Use ontology_describe to explain local meanings to the collaborator. Do not equate mental-model Alignment with ontology-term correspondence.
3. Prepare a partner-facing brief and discussion questions using artifact_prepare, retaining the HCI use context, evidence and limitations.
4. Call authorization_check/request for private notes or new outgoing excerpts. Continue with public or approved content if the owner narrows or refuses disclosure.

## Verification

Check sources and versions in the returned records. Use task_status to distinguish drafts, pending decisions, confirmed receptions and executed operations. Describe partial completion or failure explicitly; a generated final message cannot replace a receipt.

