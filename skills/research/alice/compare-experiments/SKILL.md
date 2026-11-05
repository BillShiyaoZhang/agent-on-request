---
name: compare-experiments
description: Trace a claim to metrics, experiment inputs and exact ontology versions; compare like-for-like configurations.
version: 1.0.0
metadata:
  hermes:
    category: research
---

# Compare experiments and trace claims

## When to use

Trace a claim to metrics, experiment inputs and exact ontology versions; compare like-for-like configurations.

## Ontology and contract

- Modules: evidence.
- Inputs: ResearchClaim, ExperimentRun.
- Outputs: BenchmarkReport.
- Tools: `knowledge_search`, `artifact_prepare`, `knowledge_record`.
- Effects: write-local-draft, write-private-knowledge. Skill instructions do not themselves grant these effects.

## Procedure

Use knowledge_record when the owner asks to maintain research memory: submit typed private nodes and relations with source references. This updates only the current identity workspace and cannot certify public content or create authorization.

1. Find the ResearchClaim using knowledge_search, follow supportedBy to metrics, then trace the producing ExperimentRun.
2. Retrieve the exact dataset, mapping-set and source/target ontology artifact versions used by that run.
3. Compare configurations before comparing numerical metrics. Label missing observations and synthetic fixture evidence explicitly.
4. Use artifact_prepare to write a BenchmarkReport with source references, context and limitations. Do not invent measurements or turn fixture results into empirical claims.

## Verification

Check sources and versions in the returned records. Use task_status to distinguish drafts, pending decisions, confirmed receptions and executed operations. Describe partial completion or failure explicitly; a generated final message cannot replace a receipt.

