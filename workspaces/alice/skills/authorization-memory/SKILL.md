---
name: authorization-memory
description: Explain the owner's current permissions with a sourced private brief, propose future rules for confirmation, and check authority before an external effect.
version: 2.0.1
metadata:
  hermes:
    category: research
---

# Retrieve, explain and request authorization

## When to use

Answer the owner's questions about current permissions, prepare a future-rule proposal, or check a concrete disclosure or reservation before execution.

## Ontology and contract

- Modules: work, materials.
- Inputs: Task.
- Outputs: Decision, DocumentVersion.
- Tools: `task_status`, `knowledge_search`, `authorization_list`, `authorization_check`, `authorization_request`, `authorization_propose_policy`, `artifact_prepare`, `task_checkpoint`.
- Effects: write-local-draft, request-owner-decision, propose-standing-policy. Skill instructions do not grant disclosure or execution authority.

## Procedure

### Explain permissions to the owner

1. Read task_status to identify the authenticated owner's actual question. Use authorization_list to retrieve relevant formal policies, requests, decisions and grants; knowledge_search may locate their references. Distinguish preferences, study consent, memory confirmation and peer claims from permission issued by this owner.
2. When the question identifies an exact candidate action, call authorization_check once for that action, resource, selected fields, recipient and purpose. Report the returned allowed, needs_approval or denied status accurately. If the question only asks about general rule scope, explain the formal records without inventing a concrete external action.
3. A permission explanation is an internal reply to the owner. Reading the owner's formal records and saving a private, owner-only brief do not require an external-effect grant. Do not call authorization_request merely to obtain permission to explain a rule or save this local answer.
4. Do not keep changing fields, recipient, resource or purpose until a check says allowed. A denied or needs_approval result is useful evidence for the answer, not a reason to probe for a broader interpretation. Preserve the original requested target and explain any limits.
5. Call artifact_prepare with kind "brief", a short title, plain text fields explaining the actual rule scope and check result, and sourceRefs containing the exact formal policy, request or decision IDs returned by authorization_list. Keep the brief private and do not send it to the collaborator.
6. After the sourced brief is saved, call task_checkpoint with status "complete" and a concise summary of the saved answer. End this run; do not repeat unchanged checks or create unrelated knowledge records.

### Propose a future rule

For an authenticated owner's instruction about future permissions, call authorization_propose_policy with explicit effect, actions, resources or trusted resource class, selected fields when limited, recipient and purpose. Preserve restrictions such as "summary only" in the fields list. Show the candidate for trusted owner confirmation, save a needs_owner checkpoint and end the run. The candidate itself grants no authority and must not be treated as an allowed operation. Only the trusted owner interface can issue or revoke authority.

### Execute an external effect

Before an actual outgoing disclosure or reservation requested by the owner, retrieve current authorization and call authorization_check for the exact action that execution will use, even if a remembered or KG-projected rule appears to allow it. An earlier explanatory check does not replace this execution-time check.

If the exact operation needs a one-shot decision, call authorization_request for that unchanged action, content version, fields and recipient, then checkpoint and yield. Resume from task_status after the owner decides; use approvedIntent.fields exactly when narrowed. Do not repeat an unchanged denied request or treat an expired, revoked, consumed or different-task grant as active.

## Verification

For an owner-only explanation, verify that the private brief exists, cites formal records and answers the requested scope before checkpointing complete. Saving this answer has not disclosed material or booked a resource.

For a future rule, verify a trusted owner decision before relying on the rule. For an external effect, inspect actual operation receipts separately from permission: a grant or a generated final message does not prove delivery or reservation. Later tasks must retrieve the current authorization again.

