---
name: organize-user-study
description: Connect research questions, protocols, sessions, observations and findings without treating interpretations as observations.
version: 2.0.0
metadata:
  hermes:
    category: research
---

# Organize user-study evidence

## When to use

Connect research questions, protocols, sessions, observations and findings without treating interpretations as observations.

## Ontology and contract

- Modules: study, findings.
- Inputs: UserStudy, Observation.
- Outputs: StudyReport.
- Tools: `knowledge_search`, `artifact_prepare`, `artifact_revise`, `knowledge_record`.
- Effects: write-local-draft, write-private-knowledge. Skill instructions do not themselves grant these effects.

## Procedure

Use knowledge_record when the owner asks to maintain research memory: submit typed private nodes and relations with source references. This updates only the current identity workspace and cannot certify public content or create authorization.

1. Use knowledge_search to trace the research question through UserStudy, StudyProtocol and StudySession to observations.
2. Keep protocol plans, recorded observations and interpreted findings as separate objects with their sources and limitations.
3. Prepare or revise a StudyReport using artifact_prepare/revise, clearly marking the fixture as synthetic and retaining evidence references.
4. ParticipantConsentRecord concerns a study participant and never grants this agent permission to share notes or perform an operation.

## Verification

Check sources and versions in the returned records. Use task_status to distinguish drafts, pending decisions, confirmed receptions and executed operations. Describe partial completion or failure explicitly; a generated final message cannot replace a receipt.

