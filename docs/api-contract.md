# Implementation contract

All app JSON is UTF-8; errors are `{error:{code,message,details?}}`. Node.js 26+; no production npm dependencies. Server serves `public/`. HTTP app API has no request/body access logs. Session state stays in memory; only consented whitelisted research events are persisted. Config profiles and server-held model configuration may be persisted independently of participant research consent.

## Roles and frontend

Participant controls Alice. Authenticated researcher controls Bob's behavior/permissions and both Agents' LLM settings. Admin approval never creates an Alice data grant. Alice/Bob have separate local permission-restricted processes/stores. Product UI defaults to English and fictional people/data. Do not store choices, calendar or dialogue in localStorage. Only current participant token/session ID and unconfirmed submission ID may be in sessionStorage. Admin token is memory-only. View state may use URLs; default participant view, admin login opens a small in-page dialog. A write-only password field sends provider credentials to the server; responses and browser storage never contain them.

## API

`GET /api/meta`: `{title,modes:[{id:'controlled'|'live'|'replay',label,available,description}],live:{available,model,disclosure},consentVersion:'research-v1',runtime:{alice,bob}}`.

`POST /api/sessions` body `{mode,researchConsent,previousSessionId?,previousToken?}`: `{token,state}`. A fresh session snapshots Bob's template, initializes both isolated stores, and exposes Start only when ready. A previous authenticated session is closed/evicted before replacement. Replay has no research collection by default.

Participant requests use `Authorization: Bearer <participant-token>`; authenticated admin also reads sessions. `GET /api/sessions/:id` returns `state`.

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
 task:{outcome:null|'arranged'|'boundary_kept'|'declined'|'ended',meeting:null|{day,time}},
 runtime:{alice:{online,transport:'ipc',isolation},bob:{online,transport:'ipc',isolation}},
 models:{revision,provider,baseUrl,agents:{Alice:{model,temperature,maxTokens,timeoutSeconds,retryLimit,thinking},Bob:{...}},disclosure},
 replay:null|{source,index,total,steps}
}
```

Stages: `initial`, `additional`, `waiting_admin`, `paused`, `complete`, `replay`. While paused retain the saved step. The UI shows exact approved-to-received receipts; never label mere enqueue as peer receipt.

`POST /api/sessions/:id/preview` body `{stage:'initial'|'additional',choice}` -> `{rows,fields,window,payloadHash,recipient:'Bob',sessionVersion}`. Initial choices `free|busy|full|none`; additional `keep|narrow|week`. Initial time window Tue-Wed, narrow = Thu free only, week = full week. Preview never sends.

`POST /api/sessions/:id/actions` body `{action,choice?,previewHash?,requestId,expectedVersion,answer?}` -> `{state}`. Actions `share_initial`, `respond_additional`, `stop_sharing`, `end`, `answer_prediction`, `answer_revocation`, `replay_next`. User sharing requires a matching exact preview hash. Request ID provides idempotency; a stale changed intention returns 409, never auto-resubmit a new ID. A delivered Bob brief may require an admin grant. A denial can still finish a meeting without the optional brief.

Authenticated End/stop intents validate request ID, digest and the version at receipt before immediately invalidating in-flight planning. They do not wait for the model-held session queue to perform cancellation. Final cleanup runs through the queue, preserving real received receipts; older plans cannot submit late actions. Sharing and approvals retain strict version checks. Pause, current-round config changes, reset and shutdown use the same cancellation boundary. Restrictive actions never create a sharing grant.

## Admin

`POST /api/admin/login` `{pin}` -> `{token,expiresAt}`; admin endpoints bearer-authenticated. `POST /api/admin/logout` invalidates token. PIN configured via `AGENT_DEMO_ADMIN_PIN` or generated/printed at startup, never in browser. Login rate limited in memory.

`GET /api/admin/sessions` -> `{sessions:[{id,epoch,stage,mode,researchConsent,configRevision,pendingCount,startedAt}],runtime}`.

`GET /api/admin/config?sessionId=...` -> `{template,templateRevision,active,activeRevision,profiles:[{name,config}],versions}`. If no session, active and activeRevision are null. Config draft belongs to frontend; active is authoritative backend state.

`POST /api/admin/config/validate` `{config,sessionId?}` -> `{valid,errors,diff:[{path,before,after}]}`.

`POST /api/admin/config/apply` `{config,target:'template'|'session',sessionId?,expectedRevision}` -> `{template,templateRevision,active,activeRevision,state?}`. Template update affects only new rounds. Session update is a temporary override, pauses Bob at a safe point, invalidates changed pending Bob approvals and must be rechecked before resume. Already sent receipts are immutable. Alice permissions stay controlled by participant. Unknown config keys survive read/edit/persist.

`POST /api/admin/profiles` `{name,config}` saves profile; `GET /api/admin/profiles` -> `{profiles}`.

`GET /api/admin/models` -> `{config,revision,keyConfigured}`. `config` is `{provider:'minimax_cn_token_plan'|'openai_compatible',baseUrl,agents:{Alice:{model,temperature,maxTokens,timeoutSeconds,retryLimit,thinking:'disabled'|'adaptive'},Bob:{...}}}`. Defaults are China Token Plan at `https://api.minimax.cn/v1`, both roles `MiniMax-M3`, temperature 1, output 4096, timeout 45 seconds, retry 0 and thinking disabled.

`POST /api/admin/models/validate` `{config}` -> `{valid,errors,diff}`. Unknown/credential fields are rejected. `POST /api/admin/models/apply` `{config,expectedRevision,apiKey?,clearKey?}` -> the redacted view. Empty/absent key keeps the current key; `clearKey:true` explicitly removes it. Changing provider/endpoint with a saved key requires replacement or clearing. A stale revision returns 409. Models and credentials are immutable per round; apply affects new rounds only.

`POST /api/admin/models/test` `{role:'Alice'|'Bob'}` -> `{role,model,latencyMs,response}`. Uses saved settings and a synthetic connectivity prompt, never a participant context. The response is a fixed safe acknowledgement; raw provider text/reasoning is not returned. It consumes the configured provider's quota when a real endpoint is selected. API errors never copy provider response bodies or credentials.

`GET /api/admin/sessions/:id/approvals` -> `{approvals:[{id,owner,sessionId,epoch,actionId,kind,summary,recipient,purpose,resource,fields,values,payloadHash,policyRevision,status,expiresAt,reason}]}`.

`POST /api/admin/approvals/:id/decision` `{decision:'allow_once'|'allow_round'|'deny',fields?,expectedPolicyRevision,expectedPayloadHash,maxUses?,expiryMinutes?}` -> `{state}`. Selection may narrow only; receiver/resource/purpose are exact. One-time grants do not modify templates; round grants bounded by recipient/resource/fields/uses/expiry/session and must not silently broaden. Closed dialog leaves request pending. Decisions verify epoch, policy and immutable pending action; stale approvals 409.

`POST /api/admin/sessions/:id/intervene` `{action:'pause'|'resume'|'reset'|'disconnect_bob'|'restore_bob'|'retry'|'inject_request',kind?}` -> `{state,token?}`. `reset` returns fresh `{state,token}`, revokes prior participant token/epoch and clears both stores; consent resets off. `retry` verifies receipt for same operation and never widens scope. Inject request is explicitly marked researcher intervention. `resume` after config change rechecks Bob only and recreates superseded approval where needed.

`GET /api/admin/research` -> `{runs:[{runId,mode,scenarioVersion,startedAt,status,quality,configRevision,events}],summary:{runs,completed,stopped,technical,replayExcluded}}`; only consented records exist. `GET /api/admin/research/export?format=jsonl|csv` downloads. Actual records only, no fictional aggregate data. Record admin interventions/config revisions separately, admin wait duration separate from participant decision timing. Feedback optional and separately enabled; no identity/IP/raw dialogue.

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
- `initialize({sessionId,epoch,mode,aliceData,bobConfig,configRevision})` -> readiness, sends Alice data only to Alice and Bob config/data only to Bob.
- `projectAlice({sessionId,epoch,stage,choice})` -> `{rows,fields,window}` deterministic projection of Alice own fixture; no calls to Bob.
- `deliverToBob({sessionId,epoch,operationId,rows,fields,window,payloadHash})` -> `{receipt:{operationId,payloadHash,status:'received',receivedAt}}`, immutable/idempotent peer receipt. Conflicting same ID errors. Envelope authenticated, stale epochs rejected.
- `planBob({sessionId,epoch,purpose:'initial'|'additional'|'brief',configRevision})` -> `{message,action:{type:'request_more'|'meeting'|'no_match'|'share_brief',meeting?,fields?,values?,resource?}}`. Only actual received rows + Bob own data/context. Live calls model; deterministic mode no model; valid meeting constrained to shared intersection.
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
- `stage:complete` records a task outcome, while the research run remains open for answers until end/reset/replacement/expiry. `summary.taskCompleted`, `runsPendingClose`, and `affectedByTechnical` distinguish outcome, record closure and recovered faults. Persistent restart marks orphaned active research records `incomplete + process_interrupted`.
- Bob pending deliveries include the actual permission expiry. Expired recovery verifies a prior receipt without sending; if absent, the controller requests fresh exact permission. Round grants preserve narrowed fields and values, finite uses, recipient, resource and purpose.
- A grant omitting required availability fields cannot produce a meeting result. Remote cleanup uncertainty revokes local credentials/operations, closes the research record, and blocks new rounds until cleanup is confirmed.
