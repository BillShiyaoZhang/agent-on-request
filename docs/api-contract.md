# Implementation contract

All app JSON is UTF-8; errors are `{error:{code,message,details?}}`. JSON request bodies are limited to 256 KiB. Node.js 26+; no production npm dependencies. Server serves `public/`. HTTP app API has no request/body access logs. Controller execution state stays in memory. In native KG mode, initialization snapshots, confirmed receipt records and round results also persist in the role-local KG-plugin stores. Consented `research-v2` rounds persist whitelisted metadata and complete synthetic state traces separately. Legacy `research-v1` records retain their metadata-only whitelist. Config profiles and server-held model configuration may be persisted independently of participant research consent.

## Roles and frontend

The audience starts at `/` and controls Alice. The operator opens `/console` to manage initial defaults, Bob's behavior and approvals, model settings, connections and research review. PIN mode requires researcher sign-in for console APIs. Local open-controls mode grants console access on loopback. Admin approval cannot create an Alice data grant. Ontology mappings establish meanings for a task, while disclosure requires a separate decision. Alice and Bob have separate local permission-restricted processes and stores under a trusted central controller. The audience sees Alice's owner state and confirmed exchanges. The authenticated observer API exposes both synthetic states. Current participant credentials and an unconfirmed request can be stored in sessionStorage. The admin token stays in memory. A write-only password field sends provider credentials to the server.

In native KG mode the operator follows role-specific links to KG-plugin for graph/data management and to Hermes Dashboard for models, skills, tools and profile settings. The demo console supplies orchestration, Agent Comm status and Bob's exact-field approval. The KG workbenches use distinct role credentials. Hermes Dashboard stays loopback-bound behind each published localhost port and uses its native session identity for mutations. `GET /api/admin/native` requires console authorization and returns `{enabled:true,agents:{Alice:{kgUrl,hermesUrl},Bob:{kgUrl,hermesUrl}}}`. Each `kgUrl` carries only that role's KG-console handoff token in its fragment. The console token can manage native starting data and read demo snapshots. Demo-adapter writes require a distinct server-held service token, so a workbench session cannot manufacture delivery or result records. Audience responses expose the provider and persistence disclosure, without native credentials or Bob's private source graph.

The native knowledge adapter uses each role's actual KG-plugin `MemoryService` and `KGStore`. Baseline calendar rows, brief fields and graph records are individually managed native records. New rounds reconstruct their normalized conditions from the current native records and enabled Hermes skill files. `begin` freezes a session/epoch-specific profile; later baseline edits apply to future rounds. `recordReceipt` writes only the recipient's exact confirmed incoming record, using the existing operation ID. Retries preserve content and cannot duplicate or broaden the receipt. `finish` records the result and trace, and `snapshots` reads the same records for the summary and graph. A failed native read or write is surfaced for recovery instead of switching to a local fixture.

## API

`GET /api/meta`: `{title,modes:[{id:'controlled'|'live'|'replay',label,available,description}],live:{available,model,disclosure},consentVersion:'research-v2',runtime:{alice,bob}}`.

`POST /api/sessions` body `{mode,researchConsent,initialConditions?,expectedConditionsHash?,previousSessionId?,previousToken?,ontologyScenario?,alignmentReview?,task?}`: `{token,state}`. `ontologyScenario` is `distinct` (default, published invitation meaning) or `ambiguous` (Free means only an unoccupied calendar). `alignmentReview` is an optional boolean, default false for compatibility API calls; the browser always sends true for new rounds and has no separate review toggle. `task` is `{type:'schedule',durationMinutes:15|30|45|60}`, default 30; the browser offers 30/45/60. Reviewed or ambiguous scenarios begin at `alignment`; an unambiguous API quick start with review omitted negotiates a known Guided mapping automatically, even when later meeting planning is Live. Browser Live review uses both models' candidate selection. Replay has no active ontology exchange.

Omitting `initialConditions` uses the native baseline in native KG mode. That mode rejects explicit fixture overrides so the native management interfaces remain the starting-data authority. Outside native KG mode, omission uses the saved operator default for the new round, or the conference preset based on the current Bob owner template when the saved default is unset. Explicit `initialConditions` accepts a composition request or a complete resolved condition object. The server verifies any supplied `expectedConditionsHash` and initializes both isolated stores. A hash mismatch returns 409 `STALE_CONDITIONS`. For an explicit override that changes Bob's resolved profile, supply a current researcher token using `X-Researcher-Token` (or the bearer token) in PIN mode. Without it, creation returns 401 `BOB_CONDITIONS_AUTH`. A previous authenticated session is closed and evicted before replacement. Replay does not collect research.

Participant requests use `Authorization: Bearer <participant-token>`; authenticated admin also reads sessions. `GET /api/sessions/:id` defaults to `perspective=owner`, including when an administrator is authenticated. `?perspective=observer` requires administrator authority; invalid perspectives fail. Session creation and participant actions also return the owner view. The owner view retains Alice's initialized profile and actual incoming information but omits Bob's unshared initial profile and sets `agentStates.Bob` to null. The library-level `SessionEngine.view()` defaults to observer for existing research/test callers.

State shape:

```js
{
 session:{id,epoch,version,stage,mode,modelRevision,researchConsent,consentVersion,startedAt,ended,paused},
 alice:{calendar:[{day,time,status,title,note}],stopped:false},
 bob:{name:'Bob',configRevision,templateRevision,online:true},
 choices:{initial:null,additional:null},
 receipts:{aliceToBob:[{operationId,fields,window,rows,payloadHash,status,receivedAt}],bobToAlice:[{operationId,fields,values,payloadHash,status,receivedAt}]},
 messages:[{from:'Alice'|'Bob'|'system',text,kind,at}],
 pendingApprovals:[{id,owner:'Bob',summary,status:'pending'}],
 waiting:null|{reason:'admin'|'peer_offline'|'model_timeout'|'configuration_changed',message},
 task:{outcome:null|'arranged'|'boundary_kept'|'declined'|'ended',meeting:null|{day,time},reason?:string},
 runtime:{alice:{online,transport:'ipc',isolation},bob:{online,transport:'ipc',isolation}},
 models:{revision,provider,baseUrl,agents:{Alice:{model,temperature,maxTokens,timeoutSeconds,retryLimit,thinking},Bob:{...}},disclosure},
 replay:null|{source,index,total,steps},
 initialConditions:{schemaVersion:1,presetId,componentIds,agents:{Alice,Bob}},
 conditionsHash:'sha256',
 agentStates:{Alice:{id,label,kg,skills,data,authorization,stats},Bob:null|{...}},
 perspective:'owner'|'observer',
 ontology:null|{version:'task-modular-dialogue-v1',revision,scenario,mode,task,status,ontologyVersions,
   selectedModules,excludedModules,proposal,interpretation,transcript,registry,protocol?},
 briefOntology?:null|{...},
 additionalRequest:null|{days:['Mon'|'Tue'|'Wed'|'Thu'|'Fri'|'Sat'|'Sun'],fields:['day','time','status'],reason:'no_match'}
}
```

Stages: `alignment`, `initial`, `additional`, `waiting_admin`, `paused`, `complete`, `replay`. While paused retain the saved step. The UI shows exact approved-to-received receipts; never label mere enqueue as peer receipt. `task.reason` distinguishes a kept sharing boundary from no matching shared time, an alignment rejection and a denied Bob action; do not infer the reason from `outcome` alone.

Ontology status is `awaiting_alignment|needs_clarification|accepted|rejected`. Modules contain owner, purpose, namespaced concepts/properties, definitions, datatypes and constraints. `proposal.mappings` preserves the bounded proposal; `registry.mappings` contains accepted mappings only. `registry` is `{version:1,mappingVersion:null|sha256,mappings,facts,receipts,hash}`. Facts reference the actual receipt ID, payload digest, source fields, mapping IDs and mapping version. Scheduling facts use Bob's native `{weekday,startMinute,endMinute,bookable}` values. A mapping registry may be accepted before there are any received facts. `protocol` is finite signed peer evidence, separate from the safe explanatory transcript. See [ontology-dialogue.md](ontology-dialogue.md) for the mechanism and precise limits.

`agentStates` is a derived readable view. `kg.nodes` have `{id,label,type,origin:'own'|'received',details:[{label,value}],provenance?}`; received provenance is `{operationId,fields,receivedAt,sender}`. Edges have `{id,source,target,relation,label,origin,operationId?}`. Each graph contains only that agent's own initial KG/data and confirmed incoming receipt fields. Pending payloads and approvals never enter the recipient graph. `skills` is `[{id,label,description,enabled,customized?}]`; custom or overridden labels include `customized:true` so clients preserve their text during language switching. Bob uses current configuration capabilities. `data` is an array of readable own-dataset and received-snapshot cards. `authorization` contains `{status,summary,cards,receivedSnapshotsRetained:true}`; cards expose fields, windows, maximum/used/remaining uses, expiry, confirmation mode and a pending-send reservation count. Statuses are `active|pending|expired|exhausted|disabled`; unknown historical grant totals are null. `stats` counts own nodes, received nodes, edges and confirmed incoming receipts.

## Initial-condition service

`GET /api/conditions/catalog` returns `{schemaVersion:1,defaultPresetId,defaultInput,categories,roles,days,skills,presets,components,limits,composition,templateRevision}`. Categories are `kg|data|skills|authorization`; roles are `Alice|Bob`. Catalog entries include names, descriptions and actual category patches. The reference preset and Bob owner-template components use current template data/skills/policy rather than a static copied baseline.

`GET /api/conditions/schema` returns JSON Schema for both composition requests and complete resolved conditions. Semantic validation additionally rejects graph reference errors, invalid time intervals, wrong-role or conflicting components, unknown properties, credentials, prototype keys and non-JSON inputs. Both roles can enable custom skill IDs; registered IDs must match their role. Custom labels and instructions do not create executable actions. Only fictional data is accepted. Catalog skills expose `registered` so clients can distinguish runtime actions from custom metadata.

`POST /api/conditions/resolve` accepts the composition object directly, or a complete resolved object, and returns `{conditions,hash,templateRevision,requiresResearcher,agentStates}`. It validates and previews without starting either worker or creating a session/research record. Resolving Bob changes does not grant the right to run them; session creation checks the researcher credential separately.

Composition example:

```json
{
  "schemaVersion": 1,
  "presetId": "conference",
  "componentIds": { "Alice": ["alice-auth-minimal"], "Bob": [] },
  "custom": { "Alice": { "data": { "calendar": [] } } }
}
```

Resolution applies preset, then selected category components, then custom patches. Select at most one component per category per role; a selected component replaces the preset's corresponding category. Arrays replace in full. An explicit resolved `agents` object is validated as complete and is not merged with template data. `custom` can be used with preset `custom` for a from-scratch fixture; its empty starting state grants no sending capabilities or scope.

Canonical schema:

```js
{
 schemaVersion:1,presetId,componentIds:{Alice:[],Bob:[]},
 agents:{
  Alice:{kg:{nodes:[{id,label,type}],edges:[{id,source,target,label}]},
   data:{calendar:[{day,time,status:'Free'|'Busy',title,note}]},skills:[],skillDefinitions:[{id,label,description}],
   authorization:{fields:[],windows:[],maxUses,expiryMinutes}},
  Bob:{kg:{nodes:[{id,label,type}],edges:[{id,source,target,label}]},
   data:{availableTimes:[{day,time}],brief:{topic,agenda,...syntheticJsonFields}},skills:[],skillDefinitions:[{id,label,description}],
   authorization:{recipients:[],fields:[],resources:[],window,maxUses,expiryMinutes,confirmation,askAdminForNewScope}}
 }
}
```

KG IDs are unique and all edge endpoints must exist. Current limits are 200 nodes, 400 edges and 500 calendar entries per agent; usage budget is 1–10,000 and expiry 0.01–1,440 minutes. Each input and resolved fixture has at most 20,000 JSON values and nesting depth 48. Time intervals use valid same-day `HH:mm–HH:mm` or `HH:mm-HH:mm` with an end after the start. Bob's brief may contain additional safe fictional JSON fields, including nested values. Bob recipients, fields, resources and confirmation mode preserve validated owner configuration labels; only known runtime actions execute, and `bounded` is the policy mode that permits limited sends without a fresh review. Consult the returned catalog/schema rather than hardcoding component or skill lists.

`skillDefinitions` is optional, with at most 100 `{id,label,description}` entries. IDs are unique, must be enabled in the same profile's `skills`, and are limited to 128 characters; labels to 200 and multiline descriptions to 4,000. Labels and instructions appear in that role's readable state and Live planning context, including persisted synthetic traces. A custom instruction cannot expand the allowed action registry or sharing scope. Bob owner configuration accepts the same definitions under `tools.skillDefinitions`, with IDs enabled in `tools.capabilities`; Alice-only registered IDs are rejected there as well. Replacing skills prunes definitions for removed IDs when no explicit replacement definitions are supplied.

`POST /api/sessions/:id/preview` body `{stage:'initial'|'additional',choice}` -> `{rows,fields,window,payloadHash,recipient:'Bob',sessionVersion}`. Initial choices `free|busy|full|none`; additional `keep|narrow|week`. Initial requested window is Tue-Wed; narrow requests free rows on `additionalRequest.days`, dynamically selected from Bob's current availability and received information; week requests the full week. The default fixture still requests Thursday. Actual fields/days are intersected with Alice's initialized authorization; `window` may be a day array for a narrowed date set. Preview requires the read/preview skills and remains available when sending is disabled, exhausted or expired. Sending separately enforces the send capability, usage budget and expiry. Preview never sends or consumes a use; none/keep remains available without widening authorization.

`POST /api/sessions/:id/actions` body `{action,choice?,previewHash?,requestId,expectedVersion,answer?,decision?,calendarFreeMeansBookable?,expectedAlignmentVersion?}` -> `{state}`. Actions `alignment_decision`, `share_initial`, `respond_additional`, `stop_sharing`, `end`, `answer_prediction`, `answer_revocation`, `answer_alignment`, `answer_module`, `replay_next`. User sharing requires a matching exact preview hash and accepted scheduling alignment. Request ID provides idempotency; a stale changed intention returns 409, never auto-resubmit a new ID. A delivered Bob brief may require an admin grant. A denial can still finish a meeting without the optional brief.

`alignment_decision` sends `decision:'accept'|'clarify'|'reject'` and `expectedAlignmentVersion:state.ontology.revision`. This is the mutable revision integer, not the ontology schema version string. A stale revision returns `STALE_ALIGNMENT`. `clarify` without a boolean asks for an explanation and keeps the dialogue pending. An ambiguous acceptance requires explicit `calendarFreeMeansBookable:true`; clarification with false rejects the invitation interpretation. These decisions authorize only the bounded ontology interpretation/schema dialogue. Exact data disclosure remains a later owner action.

Authenticated End/stop intents validate request ID, digest and the version at receipt before immediately invalidating in-flight planning. They do not wait for the model-held session queue to perform cancellation. Final cleanup runs through the queue, preserving real received receipts; older plans cannot submit late actions. Sharing and approvals retain strict version checks. Pause, current-round config changes, reset and shutdown use the same cancellation boundary. Restrictive actions never create a sharing grant.

## Admin

`POST /api/admin/login` `{pin}` -> `{token,expiresAt}`; admin endpoints bearer-authenticated. `POST /api/admin/logout` invalidates token. PIN configured via `AGENT_DEMO_ADMIN_PIN` or generated/printed at startup, never in browser. Login rate limited in memory.

`GET /api/admin/sessions` -> `{sessions:[{id,epoch,stage,mode,researchConsent,configRevision,pendingCount,startedAt}],runtime}`.

`GET /api/admin/runtime` returns current runtime status. In Hermes direct mode, `peerTransport` contains the bridge's availability and role-specific local addresses. In the regular runtime the role transport fields describe local process IPC.

`GET /api/admin/config?sessionId=...` -> `{template,templateRevision,active,activeRevision,profiles:[{name,config}],versions}`. If no session, active and activeRevision are null. Config draft belongs to frontend; active is authoritative backend state.

`POST /api/admin/config/validate` `{config,sessionId?}` -> `{valid,errors,diff:[{path,before,after}]}`.

`POST /api/admin/config/apply` `{config,target:'template'|'session',sessionId?,expectedRevision}` -> `{template,templateRevision,active,activeRevision,state?}`. Template update affects only new rounds. Session update is a temporary override, pauses Bob at a safe point, invalidates changed pending Bob approvals and must be rechecked before resume. Already sent receipts are immutable. Alice permissions stay controlled by participant. Unknown config keys survive read/edit/persist.

`POST /api/admin/profiles` `{name,config}` saves profile; `GET /api/admin/profiles` -> `{profiles}`.

In native KG mode, `GET /api/admin/conditions/default` returns the current `{conditions,revisions,provenance}` reconstructed from both native stores, and fixture/config/profile mutation routes return 409 `NATIVE_CONDITIONS_MANAGED`. Outside native KG mode, the endpoint returns `{revision,conditions}`. `PUT /api/admin/conditions/default` accepts `{expectedRevision,initialConditions}` and returns the updated revision and normalized conditions. Pass `initialConditions: null` to restore the built-in default. Stale revisions return 409. Saving changes the starting conditions for future rounds and persists across restart. Running rounds keep their original initialization.

`GET /api/admin/conditions` -> `{bundles:[{id,name,revision,hash,conditions,createdAt}]}` lists researcher-owned complete initial-condition fixtures. `POST /api/admin/conditions` accepts `{name,input,expectedRevision?}`, where input is either a composition or a complete resolved fixture, and returns `{bundle,bundles}`. A new name can omit expectedRevision. Updating an existing name requires its exact revision and increments it. `DELETE /api/admin/conditions/:id?expectedRevision=N` returns `{bundles}` and requires the current revision. Conflicts return 409. Bundles and the default persist in `.data/conditions.json`. The operator can download or import JSON fixtures in the workbench, then choose whether to save them.

`GET /api/admin/models` -> `{config,revision,keyConfigured}`. `config` is `{provider:'minimax_cn_token_plan'|'openai_compatible',baseUrl,agents:{Alice:{model,temperature,maxTokens,timeoutSeconds,retryLimit,thinking:'disabled'|'adaptive'},Bob:{...}}}`. Defaults are China Token Plan at `https://api.minimax.cn/v1`, both roles `MiniMax-M3`, temperature 1, output 4096, timeout 45 seconds, retry 0 and thinking disabled.

`POST /api/admin/models/validate` `{config}` -> `{valid,errors,diff}`. Unknown/credential fields are rejected. `POST /api/admin/models/apply` `{config,expectedRevision,apiKey?,clearKey?}` -> the redacted view. Empty/absent key keeps the current key; `clearKey:true` explicitly removes it. Changing provider/endpoint with a saved key requires replacement or clearing. A stale revision returns 409. Models and credentials are immutable per round; apply affects new rounds only.

`POST /api/admin/models/test` `{role:'Alice'|'Bob'}` -> `{role,model,latencyMs,response}`. Uses saved settings and a synthetic connectivity prompt, never a participant context. The response is a fixed safe acknowledgement; raw provider text/reasoning is not returned. It consumes the configured provider's quota when a real endpoint is selected. API errors never copy provider response bodies or credentials.

`GET /api/admin/sessions/:id/approvals` -> `{approvals:[{id,owner,sessionId,epoch,actionId,kind,summary,recipient,purpose,resource,fields,values,payloadHash,policyRevision,status,expiresAt,reason}]}`.

`POST /api/admin/approvals/:id/decision` `{decision:'allow_once'|'allow_round'|'deny',fields?,expectedPolicyRevision,expectedPayloadHash,maxUses?,expiryMinutes?}` -> `{state}`. Selection may narrow only; receiver/resource/purpose are exact. One-time grants do not modify templates; round grants bounded by recipient/resource/fields/uses/expiry/session and must not silently broaden. Closed dialog leaves request pending. Decisions verify epoch, policy and immutable pending action; stale approvals 409.

`POST /api/admin/sessions/:id/intervene` `{action:'pause'|'resume'|'reset'|'disconnect_bob'|'restore_bob'|'retry'|'inject_request',kind?}` -> `{state,token?}`. `reset` returns fresh `{state,token}`, revokes prior participant token/epoch and clears both stores; consent resets off. `retry` verifies receipt for same operation and never widens scope. Inject request is explicitly marked researcher intervention. `resume` after config change rechecks Bob only and recreates superseded approval where needed.

`GET /api/admin/research` -> `{runs:[{runId,mode,scenarioVersion,consentVersion,startedAt,status,quality,configRevision,events,initialConditions?,conditionsHash?,trace?}],summary:{runs,completed,stopped,technical,replayExcluded,...}}`; only consented records exist. `GET /api/admin/research/export?format=jsonl|csv` downloads actual records. V2 adds complete synthetic state traces; v1 remains metadata-only. Record admin interventions/config revisions separately, with admin wait duration separate from participant decision timing. Raw dialogue, IPs and credentials are excluded. Internal session/operation identifiers permit pseudonymous step correlation.

Each trace step is `{seq,at,kind,eventSeq:null|number,snapshot,previousHash:null|string,hash}`. A snapshot has `schemaVersion:'agent-trace-v1'`, fixed `capturedAt`, canonical `conditions`, current task configuration, calendar, receipts, approvals, grants, counters, choices, task, stage/version and execution flags, plus derived `agentStates`. `config` deliberately omits prompts, runtime/model settings and arbitrary extensions. Participant/admin tokens, provider endpoints/keys, raw chat, reasoning and hidden runtime context are excluded. On reload the nested whitelist is reapplied, agent views are rebuilt using `capturedAt`, and the hash chain/event links are verified. Invalid suffixes are discarded with `trace_integrity_failed`. JSONL preserves a whole run; CSV includes quoted JSON conditions and trace columns.

Consented runs also contain `modelRevision` and `models:{revision,provider,agents:{Alice:{model,temperature,maxTokens,timeoutSeconds,retryLimit,thinking},Bob:{...}}}` captured from the actual starting round. They exclude provider URL, Key and reasoning. JSONL/CSV preserve this fixed condition; older records may have null model metadata. Model events and later global edits cannot override the starting snapshot.

## Config schema

```js
{
 persona:'Bob is a calm research collaborator.',
 objective:'Arrange a fictional 30-minute discussion with Alice.',
 prompts:{system:'...',followUp:'...'},
 data:{source:'synthetic-calendar-v1',synthetic:true,availableTimes:[{day:'Thu',time:'15:00–15:30'}],brief:{topic:'Agent collaboration interfaces',agenda:'Scope, data sharing, follow-up'}},
 collaboration:{acceptInvitations:true,allowedPeers:['Alice']},
 tools:{capabilities:['read_synthetic_calendar','send_scoped_reply','share_brief']},
 permissions:{recipients:['Alice'],fields:['day','time','status'],resources:['availability'],window:'Mon–Sun',maxUses:3,expiryMinutes:10,confirmation:'bounded',askAdminForNewScope:true},
 response:{constraints:'Respect refusal.',maxWords:80,offerBrief:true},
 runtime:{model:'configured-default',temperature:0.2,timeoutSeconds:20,retryLimit:0},
 extensions:{}
}
```

## Runtime adapter contract (owned by runtime agent)

Export `createRuntimeManager(options={})` from `src/runtime-manager.mjs`. `options` includes `bobUrl`, `bobToken`, `modelBaseUrl`, `modelApiKey`, `modelName`. Manager methods are async except the synchronous status snapshot:

- `start()` ready; synchronous `status()` -> `{alice:{online,role,transport},bob:{online,role,transport},live:{available,model,disclosure}}`.
- `configureModels({config,revision,apiKey})` is an internal parent-only call. The secret-bearing snapshot must never be returned by HTTP. Workers receive sanitized availability, model and role settings only. Existing rounds keep their prior snapshot.
- `modelInfo({sessionId,epoch}?)` returns only public configuration/disclosure for the current global settings or exact active round.
- `initialize({sessionId,epoch,mode,aliceData,aliceProfile?,bobProfile?,bobConfig,configRevision,ontologyDialogue?,alignReview?})` -> readiness plus model/ontology metadata. Sends Alice data/profile only to Alice and Bob config/profile only to Bob. Each worker receives its own ontology profile; the peer working subset arrives through signed dialogue, not complete private initialization. The model receives only its owning initialized KG; peers gain knowledge through confirmed deliveries.
- `negotiateOntology({sessionId,epoch,dialogue,...})` exchanges the selected modules, proposal, decision and acknowledgements across both real workers and returns the decided dialogue and bounded signed protocol evidence. Acceptance/rejection are peer decisions rather than a controller-only label. Follow the implementation for internal options; this method is not exposed as an unauthenticated HTTP endpoint.
- `projectAlice({sessionId,epoch,stage,choice,days?})` -> `{rows,fields,window}` deterministic projection of Alice own fixture intersected with initialized fields and weekday authorization; no calls to Bob. Additional narrow requests can name bounded weekdays. Registered read/preview skills are required. Worker outgoing preparation separately enforces the send skill, use limit and expiry.
- `deliverToBob({sessionId,epoch,operationId,rows,fields,window,payloadHash})` -> `{receipt:{operationId,payloadHash,status:'received',receivedAt}}`, immutable/idempotent peer receipt. Conflicting same ID errors. Envelope authenticated, stale epochs rejected.
- `planBob({sessionId,epoch,purpose:'initial'|'additional'|'brief',configRevision})` -> `{message,action:{type:'request_more'|'meeting'|'no_match'|'share_brief',meeting?,fields?,values?,resource?}}`. Scheduling queries receipt-backed Bob-ontology facts produced by accepted mappings plus Bob's own native availability. Live calls the model; deterministic mode does not. A valid meeting must fit the task duration and the interpreted shared intersection.
- `planAlice({sessionId,epoch,purpose:'intro'|'proposal',mode})` -> `{message}` uses isolated Alice context. Live optional, errors explicit, never silent fallback.
- `deliverToAlice({sessionId,epoch,operationId,fields,values,payloadHash})` -> Bob signed outgoing to Alice, same receipt shape.
- `verifyReceipt({sessionId,epoch,direction:'bob'|'alice',operationId,fields,rows?,window?,values?,payloadHash})` -> `{receipt}` or `null`. Read-only verification of an existing signed proof; a missing proof or failed connection never causes a transmission.
- `updateBob({sessionId,epoch,bobConfig,configRevision})` preserves received snapshots, replaces Bob policy/context safely.
- `cancelPlanning({sessionId,epoch},roles=['Alice','Bob'])` aborts model planning without deleting received snapshots, outgoing ledgers, peer identities or permissions. It does not authorize or deliver an operation.
- `clear({sessionId,epoch})` evicts both stores and rejects late same-epoch traffic.
- `setBobOnline(boolean)` simulates transport availability; status reflects. Restoration does not send new requests.
- `close()` cleans workers.

The event server forces local Bob even if a legacy URL is provided. The manager's explicit remote option and `bob-server.mjs` remain library compatibility fixtures for Controlled tests, not the current event setup. Workers use Node permissions and private directories; provider calls run in the parent broker. Controller gates every disclosure; planning does not execute unapproved actions. The legacy Bob `runtime` schema fields are preserved in profiles but ignored by the application after global models are configured.

## Implemented additions

- Configuration views include `versions:[{revision,hash,target,createdAt,config}]`. `GET /api/admin/config/versions` exposes the same authenticated read-only archive. Session overrides are versioned without storing participant session IDs in configuration records.
- Initial free and busy projections carry `day,time,status`; busy includes both free and busy rows. Full and week add `title,note`. None/keep use `window:'none'` and empty rows/fields. Bob’s baseline availability permission uses `day,time,status`.
- `answer_prediction` accepts `approved_snapshot|outside_scope|not_sure`; `answer_revocation` accepts `future_only|delete_received|not_sure`. These are post-explanation checks.
- `answer_alignment` uses question `ontology_alignment` with `mapping_not_permission|mapping_grants_access|not_sure`; `answer_module` uses question `task_module` with `task_subset|whole_ontology|not_sure`. Expected answers are `mapping_not_permission` and `task_subset`. They follow the existing first-answer/feedback and research-consent rules.
- Optional trace fields `ontology` and `briefOntology` preserve safe versioned modules, proposals/decisions, accepted mapping and receipt-backed fact registries, plus finite protocol evidence. Legacy traces lacking these fields remain valid; the initial-condition schema/hash is unchanged. Reload uses the strict ontology sanitizer rather than accepting arbitrary messages or provider contexts.
- `stage:complete` records a task outcome, while the research run remains open for answers until end/reset/replacement/expiry. `summary.taskCompleted`, `runsPendingClose`, and `affectedByTechnical` distinguish outcome, record closure and recovered faults. Persistent restart marks orphaned active research records `incomplete + process_interrupted`.
- Bob pending deliveries include the actual permission expiry. Expired recovery verifies a prior receipt without sending; if absent, the controller requests fresh exact permission. Round grants preserve narrowed fields and values, finite uses, recipient, resource and purpose.
- A grant omitting required availability fields cannot produce a meeting result. Remote cleanup uncertainty revokes local credentials/operations, closes the research record, and blocks new rounds until cleanup is confirmed.
