# Exhibition operator guide

Use Node.js 26 or newer for the isolated Agent runtime. Production uses built-in Node modules and has no npm dependencies. Launch the app from the repository root:

```sh
npm start
```

The app defaults to port `4317`. Open the local participant page shown in the console. If `AGENT_DEMO_ADMIN_PIN` is unset, startup generates and prints an admin PIN. Set a dedicated demonstration PIN through the environment when repeatability is needed; do not put it in a saved Bob configuration or browser code. `HOST` and `PORT` control the HTTP listener.

```sh
AGENT_DEMO_ADMIN_PIN='a-dedicated-demo-pin' npm start
```

The default participant mode uses controlled local Alice and Bob processes with synthetic stores. `npm test` runs the implementation checks. Configure Live mode in the researcher's Model configuration panel: the default is MiniMax China Token Plan with `MiniMax-M3`, separate Alice/Bob settings and a shared server-held subscription key. Enter the key and click **Save API key** beside its field (or press Enter); this saves just the key and preserves other draft settings. Validate, review and save any model parameter changes separately, then test each saved role before starting a new Live round. If changing the provider or URL, validate and save that connection and its key together using **Save for new rounds**. Existing rounds keep their original model snapshot. Read [minimax.md](minimax.md) for credentials, request format and the local process isolation boundary. Optional `MINIMAX_TOKEN_PLAN_KEY` initializes a first-run subscription key; saved settings take precedence. The participant page shows the model/traffic disclosure. A live provider error is a visible failure, not an automatic switch to controlled mode.

## Local rehearsal

Before admitting a participant, rehearse these paths using research consent off:

1. Preview Tue–Wed free slots. Confirm the preview does not populate Bob's receipt store. Send once and check the approved hash matches the received hash.
2. Add only Thursday free slots. Confirm Bob receives no titles/notes and can arrange the baseline common slot.
3. Decline the initial request, then decline an additional request in another round. Both paths must reach a valid complete outcome.
4. Where Bob's optional brief needs permission, open the researcher's approval. Confirm closing it leaves it pending; denial does not undo an already arranged meeting.
5. Withdraw Alice's future sharing. Confirm the existing Bob receipt remains visible and subsequent sharing is blocked.
6. Disconnect Bob, restore connectivity and then explicitly retry. Confirm restoration itself does not disclose anything. A retry must reuse the same approved operation and cannot duplicate a receipt or widen the payload.
7. Reset the round. Confirm a fresh epoch/token, both stores cleared, the prior token rejected and research consent off.
8. Finish one explicitly consented rehearsal and inspect the research export. Keep rehearsal collection separate from participant data. Deleting a rehearsal currently requires trusted operator maintenance through `ResearchStore.deleteRun()`; there is no research-panel deletion button or HTTP delete endpoint.

## Researcher's controls

The admin PIN opens researcher controls. Authentication does not create any Alice sharing permission.

The Bob template is the starting configuration for future rounds. Editing/applying it leaves an existing participant round on its original snapshot. A session-targeted apply is a temporary override for that round: it pauses Bob at a safe point, supersedes changed pending Bob approvals and rechecks the new policy before resume. Received snapshots are immutable. A saved profile is reusable configuration, not a participant research record.

Review the validation errors and diff before apply. Unknown ordinary config keys survive editing, saving and reload. Keep `data.synthetic: true` and use legal `{day,time}` availability objects. Custom capabilities are configuration names; only registered executor capabilities can run. Never paste personal Agent stores, real API keys or private calendars into this demonstration.

One-time approval authorizes one exact Bob action. Round approval is bounded by current recipient, resource, purpose, fields, uses, expiry and session. It does not automatically broaden a Bob template. Field selection can narrow a pending payload; it cannot add unsupplied fields. A changed policy revision or payload requires renewed review.

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

Research consent is optional and independent from Alice sharing. Give participants the approved information before asking for consent. Research records contain only permitted event metadata, not chat/calendar bodies or identifiers. Record substantive assistance or an injected request as an intervention and keep admin waiting distinct from participant decision time.

Reaching a task outcome does not immediately close research collection: the optional understanding questions can still be answered. The summary distinguishes task outcomes from runs awaiting an explicit End. At the end of a round inspect its outcome, end/reset it, and verify that the next person starts with a fresh session. Avoid collecting research data from replay; replay is explanation material. Export actual records from the authenticated research panel as JSONL or CSV. Keep rehearsals, altered configurations and assisted rounds identifiable for analysis. Read [research.md](research.md) for the exact recording gate and analysis rules.
