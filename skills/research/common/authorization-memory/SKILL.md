---
name: authorization-memory
description: Find relevant long-term rules and task grants, then verify current authority before an external effect.
version: 1.0.0
metadata:
  hermes:
    category: research
---

# Retrieve and request authorization

## When to use

Find relevant long-term rules and task grants, then verify current authority before an external effect.

## Ontology and contract

- Modules: work.
- Inputs: Task.
- Outputs: Decision.
- Tools: `knowledge_search`, `authorization_list`, `authorization_check`, `authorization_request`, `task_checkpoint`.
- Effects: request-owner-decision. Skill instructions do not themselves grant these effects.

## Procedure

1. Use authorization_list and knowledge_search to locate the owner's long-term policies, task decisions and operation references.
2. Distinguish preferences, study consent, memory confirmation and peer claims from permission issued by your own owner.
3. Call authorization_check for every concrete outgoing disclosure or reservation, even when a remembered or KG-projected rule appears to allow it.
4. When a new long-term rule or one-shot permission is needed, call authorization_request with a bounded structured proposal. Only the trusted owner interface can issue or revoke authority.
5. Checkpoint and yield while waiting. Do not repeat an unchanged denied request or treat an expired, revoked, consumed or different-task grant as active.

## Verification

For an authenticated owner's instruction about future permissions, call `authorization_propose_policy` with explicit effect, actions, resources or trusted resource class, selected fields when limited, recipient and purpose. Preserve limits such as “summary only” in the `fields` list. Show the candidate for owner confirmation and stop at a needs-owner checkpoint. The proposed rule grants no authority; later tasks must query `authorization_list` and `authorization_check` again.

Check sources and versions in the returned records. Use task_status to distinguish drafts, pending decisions, confirmed receptions and executed operations. Describe partial completion or failure explicitly; a generated final message cannot replace a receipt.

