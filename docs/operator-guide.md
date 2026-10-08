# Exhibition operator guide

Use Node.js 26 or newer for the isolated Agent runtime. Production uses built-in Node modules and has no npm dependencies. Launch the app from the repository root:

```sh
npm run demo
```

The demo opens at `http://127.0.0.1:4327` with all controls available directly, without researcher sign-in. It loads `MINIMAX_TOKEN_PLAN_KEY` from the project `.env`, which Git ignores; existing saved demo keys migrate automatically. `DEMO_PORT` changes the local demo port. The separate `npm start` event mode uses port `4317`, optional `HOST` / `PORT`, and PIN sign-in.

```sh
AGENT_DEMO_ADMIN_PIN='a-dedicated-demo-pin' npm start
```

The default participant mode uses controlled local Alice and Bob processes with synthetic stores. `npm test` runs the implementation checks. Configure Live mode in the researcher's Model configuration panel: the default is MiniMax China Token Plan with `MiniMax-M3`, separate Alice/Bob settings and a shared server-held subscription key. Enter the key and click **Save API key** beside its field (or press Enter); this saves just the key and preserves other draft settings. Validate, review and save any model parameter changes separately, then test each saved role before starting a new Live round. If changing the provider or URL, validate and save that connection and its key together using **Save for new rounds**. Existing rounds keep their original model snapshot. Read [minimax.md](minimax.md) for credentials, request format and the local process isolation boundary. The local demo loads `MINIMAX_TOKEN_PLAN_KEY` from the ignored `.env` automatically; key-source markers preserve explicit clear decisions. Optional PIN event mode retains first-run environment initialization. The participant page shows the model/traffic disclosure. A live provider error is a visible failure, not an automatic switch to controlled mode.

## Local rehearsal

Before admitting a participant, rehearse these paths using research consent off:

1. Open initialization and review both agents' preset, KG, data, skills and authorization cards. Try an Alice-only component change, then a Bob change using the directly available controls. Resolve and review again after modifying the owner template; the reference preset uses its current values.
1. Preview Tue–Wed free slots. Confirm the preview does not populate Bob's receipt store. Send once and check the approved hash matches the received hash.
2. Add only Thursday free slots. Confirm Bob receives no titles/notes and can arrange the baseline common slot.
3. Decline the initial request, then decline an additional request in another round. Both paths must reach a valid complete outcome.
4. Where Bob's optional brief needs permission, open the researcher's approval. Confirm closing it leaves it pending; denial does not undo an already arranged meeting.
5. Withdraw Alice's future sharing. Confirm the existing Bob receipt remains visible and subsequent sharing is blocked.
6. Disconnect Bob, restore connectivity and then explicitly retry. Confirm restoration itself does not disclose anything. A retry must reuse the same approved operation and cannot duplicate a receipt or widen the payload.
7. Reset the round. Confirm a fresh epoch/token, both stores cleared, the prior token rejected and research consent off.
8. Finish one explicitly consented v2 rehearsal and inspect its research timeline and export. Step through the initialized, delivered, approved and revoked states; confirm received KG nodes link to confirmed receipt operations, expired permissions retain the recorded timestamp and credentials/raw messages are absent. Keep rehearsal collection separate from participant data. Deleting a rehearsal currently requires trusted operator maintenance through `ResearchStore.deleteRun()`; there is no research-panel deletion button or HTTP delete endpoint.

## Initial conditions and visible state

Follow the participant page from the main collaboration flow into optional detail. First choose a sharing scope, preview the exact information and confirm only what may be sent. Review Bob's requests and the result there. The **Information Alice received** card appears only after a confirmed Bob-to-Alice receipt and shows the actual received brief values; a pending approval is not received information. Narrowing a Bob approval keeps excluded fields out of that card.

When a participant wants more context, open **Inside Alice · optional** first to inspect their own agent's calendar, knowledge, skills and permissions. Then open **Inside Bob · further detail** to inspect the peer's separate state. Both sections start collapsed, and their category cards reveal finer detail on demand. Use **Sharing receipts & earlier updates** last for exact receipt records, the complete conversation and round identifiers. These inspectors are read-only; opening a graph or card never sends information.

Choose a complete preset or compose each agent's KG, data, skills and authorization components. There is at most one component per category per role. Custom JSON patches apply last; arrays replace the selected array. The from-scratch preset starts with empty data/graphs/skills/scopes and still requires complete, validated synthetic conditions before running. Invalid time intervals, duplicate graph IDs, missing edge endpoints, unregistered skills, wrong-role components and credentials are rejected. The catalog and JSON Schema are served by the backend, and the preview uses the same resolver as session creation.

Participants may change Alice's initial conditions. The local demo also permits direct changes to Bob's KG, data, skills and authorization. The optional PIN event mode requires a researcher token obtained through sign-in for those Bob changes. API integrations send that token in `X-Researcher-Token` while retaining the participant token for any previous-session replacement. A resolve preview supplies `hash` and `requiresResearcher`; creation sends `expectedConditionsHash` and fails if effective conditions have changed. Re-preview after an owner-template update instead of guessing the current baseline values.

Review the graph and category cards inside the optional Alice and Bob sections during a round. Own knowledge and confirmed received knowledge have distinct origins; a received node carries receipt provenance. Bob cannot gain Alice's private rows or initial KG through the state visualization. Initial KG enters only its owning model context. Each agent's skills card reflects its actual current configuration, and authorization cards expose allowed fields/dates, budget consumption, remaining uses, expiry and owner-review requests. Alice read/preview/send skills and field/date/usage/expiry limits are enforced in the runtime as well as the controller. Taking a preview consumes no send budget; allocating an authorized transmission consumes a use even if receipt confirmation is delayed.

## Researcher's controls

Local demo controls are available directly. The optional PIN event mode uses sign-in. Access to these controls does not create any Alice sharing permission.

The operator console starts with the selected round, confirmed submission and receipt counts, its outcome, and the pause/resume, approval, new-round and Bob configuration actions. Open the session switcher when changing rounds. Connection simulation, retries, injected requests, technical identity and exact receipt JSON are separate optional sections.

The Bob template is the starting configuration for future rounds. Editing/applying it leaves an existing participant round on its original snapshot. A session-targeted apply is a temporary override for that round: it pauses Bob at a safe point, supersedes changed pending Bob approvals and rechecks the new policy before resume. Received snapshots are immutable. A saved profile is reusable configuration, not a participant research record.

Review the validation errors and diff before apply. Unknown ordinary config keys survive editing, saving and reload. Keep `data.synthetic: true` and use legal `{day,time}` availability objects. Custom capabilities are configuration names; only registered executor capabilities can run. Never paste personal Agent stores, real API keys or private calendars into this demonstration.

One-time approval authorizes one exact Bob action. The review shows the recipient, purpose, reason and actual field values before the decision. Unchecking a field excludes it from the approval while leaving its pending value visible for comparison. Round approval and its use/expiry settings are available in an optional section; the grant is bounded by current recipient, resource, purpose, selected fields and exact values, uses, expiry and session. It does not automatically broaden a Bob template. Field selection can narrow a pending payload; it cannot add unsupplied fields. A changed policy revision or payload requires renewed review.

Recovery operations have distinct meanings:

| Control | Effect |
|---|---|
| Pause / resume | Stop scheduling and continue after policy/state checks |
| Disconnect / restore Bob | Change transport availability; restoring does not send |
| Retry | Reconcile/reuse an existing approved operation |
| Reset | End the previous epoch, clear both synthetic stores and issue a new participant token; consent resets off |
| Inject request | Explicit researcher intervention, marked in consented research metadata |

## Both Agents on this computer

The event app always runs Alice and Bob locally; a legacy `BOB_URL` is ignored. Workers have independent private working directories and contexts, and Node permissions deny direct network access, filesystem writes, child processes, threads, addons and Inspector access. Only their registered runtime code is readable. They do not receive provider credentials. This restricts the known Worker implementation; it is not a hostile-code OS sandbox. The parent model broker makes Live requests to the configured provider, so local Agent processes do not imply a local LLM. Read [runtime.md](runtime.md) for the harness and lifecycle.

## Collecting and ending a round

Research consent is optional and independent from Alice sharing. Give participants the approved information before asking for consent. New `research-v2` collection records event metadata and complete fictional state: initial KG/data/skills/scopes, calendar and brief values, receipts, owner approvals, grants and use counters. It excludes participant/admin credentials, model keys/endpoints, configuration prompts, raw chat and reasoning. Legacy `research-v1` records remain metadata-only and are not expanded. Internal round and operation identifiers link steps; the records are pseudonymous, not completely anonymous. Record substantive assistance or an injected request as an intervention and keep admin waiting distinct from participant decision time.

Reaching a task outcome does not immediately close research collection: the optional understanding questions can still be answered. The first choice submits automatically. The page waits for server confirmation before showing the original answer alongside the expected boundary and its explanation; there is no second submit step. The first answer stays locked and is never replaced by the expected answer. If confirmation is lost, verify or retry the same original answer. Participants still receive this feedback with research consent off, but no research answer is stored. Consented records preserve the original answer and its recorded correctness; a missing answer is not treated as an incorrect answer.

The summary distinguishes task outcomes from runs awaiting an explicit End. At the end of a round inspect its outcome, end/reset it, and verify that the next person starts with a fresh session. Avoid collecting research data from replay; replay is explanation material. Export actual records from the authenticated research panel as JSONL or CSV; JSONL retains each complete run and is preferable for detailed reconstruction. Persisted traces allow later review, including after restart, but cannot restart the original agents. A broken trace hash chain is marked `trace_integrity_failed`, and an open run interrupted by restart becomes `incomplete + process_interrupted`. Keep rehearsals, altered configurations and assisted rounds identifiable for analysis. Read [research.md](research.md) for the exact recording gate and analysis rules.
