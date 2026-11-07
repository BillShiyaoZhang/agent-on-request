---
name: review-interaction
description: Compare prototypes and design alternatives against user needs, use contexts and supported findings.
version: 2.0.0
metadata:
  hermes:
    category: research
---

# Review interaction alternatives

## When to use

Compare prototypes and design alternatives against user needs, use contexts and supported findings.

## Ontology and contract

- Modules: interaction, findings.
- Inputs: InteractivePrototype, DesignAlternative.
- Outputs: DesignRationale, DesignNote.
- Tools: `knowledge_search`, `artifact_prepare`, `knowledge_record`.
- Effects: write-local-draft, write-private-knowledge. Skill instructions do not themselves grant these effects.

## Procedure

Use knowledge_record when the owner asks to maintain research memory: submit typed private nodes and relations with source references. This updates only the current identity workspace and cannot certify public content or create authorization.

1. Retrieve the InteractionContext, UserNeed, prototype version and alternative designs using knowledge_search.
2. Trace each proposed design rationale to the needs and findings that support it.
3. Compare alternatives on the stated criteria and flag unsupported assumptions. An attractive prototype is not evidence of validated effectiveness.
4. Prepare a DesignRationale or DesignNote with artifact_prepare, retaining sources. Local review does not grant permission to disclose study materials.

## Verification

Check sources and versions in the returned records. Use task_status to distinguish drafts, pending decisions, confirmed receptions and executed operations. Describe partial completion or failure explicitly; a generated final message cannot replace a receipt.

