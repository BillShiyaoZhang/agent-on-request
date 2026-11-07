---
name: semantic-review
description: Inspect researched ontology artifacts and mapping candidates; retain definitions, counterexamples and review scope.
version: 2.0.0
metadata:
  hermes:
    category: research
---

# Review semantic models and mappings

## When to use

Inspect researched ontology artifacts and mapping candidates; retain definitions, counterexamples and review scope.

## Ontology and contract

- Modules: semantics.
- Inputs: OntologyArtifactVersion, MappingCandidate.
- Outputs: HumanReviewDecision, ResearchNote.
- Tools: `knowledge_search`, `ontology_describe`, `artifact_prepare`, `knowledge_record`.
- Effects: write-local-draft, write-private-knowledge. Skill instructions do not themselves grant these effects.

## Procedure

Use knowledge_record when the owner asks to maintain research memory: submit typed private nodes and relations with source references. This updates only the current identity workspace and cannot certify public content or create authorization.

1. Retrieve the OntologyArtifactVersion, MappingSet and candidate definitions with knowledge_search.
2. Read ontology_describe to understand the application's types; do not install a researched ontology artifact as the agent's running schema.
3. Compare source and target definitions, relation direction, scope and counterexamples. Keep a proposed mapping distinct from a reviewed or accepted mapping.
4. Prepare a HumanReviewDecision or ResearchNote draft with evidence and limitations. A mapping-review decision does not authorize disclosure or booking.

## Verification

Check sources and versions in the returned records. Use task_status to distinguish drafts, pending decisions, confirmed receptions and executed operations. Describe partial completion or failure explicitly; a generated final message cannot replace a receipt.

