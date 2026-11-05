---
name: synthesize-findings
description: Trace observations supporting findings and summarize design implications with context and limitations.
version: 1.0.0
metadata:
  hermes:
    category: research
---

# Synthesize scoped research findings

## When to use

Trace observations supporting findings and summarize design implications with context and limitations.

## Ontology and contract

- Modules: findings.
- Inputs: Finding, Observation.
- Outputs: DesignImplication, StudyReport.
- Tools: `knowledge_search`, `artifact_prepare`, `artifact_revise`, `knowledge_record`.
- Effects: write-local-draft, write-private-knowledge. Skill instructions do not themselves grant these effects.

## Procedure

Use knowledge_record when the owner asks to maintain research memory: submit typed private nodes and relations with source references. This updates only the current identity workspace and cannot certify public content or create authorization.

1. Use knowledge_search to follow Finding supportedBy Observation and Observation observedIn StudySession.
2. Retrieve the applicable protocol, use context and limitations before combining findings.
3. Distinguish a reported observation, an interpretation and a suggested DesignImplication in the prepared output.
4. Create a sourced report or implication using artifact_prepare/revise. Clearly label synthetic fixture evidence and avoid claiming a real user-study result.

## Verification

Check sources and versions in the returned records. Use task_status to distinguish drafts, pending decisions, confirmed receptions and executed operations. Describe partial completion or failure explicitly; a generated final message cannot replace a receipt.

