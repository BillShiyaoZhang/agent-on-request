# Task-driven ontology dialogue

The demo uses ontology definitions to interpret received information and a semantic registry to drive scheduling. It adapts the working-subset and dialogue mechanisms of the two supplied research papers into a bounded exhibition workflow. It does not reproduce their original experiments, negotiation search or benchmark results.

The default Guided/Controlled run uses deterministic planners with real isolated Alice/Bob processes, signed dialogue messages and verified receipts. Every browser-started Controlled/Live round begins with alignment review; Live lets each agent's model select or reject registered mapping candidates, and the runtime validates the selection. Only a compatibility API call that omits `alignmentReview` can use a known Guided mapping for an unambiguous quick start even when subsequent meeting planning is Live. Invalid output, timeout and transport errors remain visible. There is no silent conversion of a failed Live run into a Guided success.

## The demonstrated disagreement

Alice and Bob have different namespace identifiers, schema versions, concept definitions, datatypes and constraints:

| Meaning | Alice calendar ontology | Bob appointment ontology |
|---|---|---|
| Interval concept | `alice:CalendarEntry` | `bob:BookableSlot` |
| Weekday | `alice:day`: `Mon`–`Sun` string | `bob:weekday`: integer 1–7 |
| Interval | `alice:time`: same-day clock range | `bob:startMinute`, `bob:endMinute`: minutes after midnight |
| Status | `alice:status`: `Free` or `Busy` | `bob:bookable`: boolean invitation eligibility |
| Label `Free` | Defined by Alice's occupancy/invitation convention | Bob's owner permits a meeting invitation |

In the `distinct` scenario Alice's published Free definition explicitly offers an unoccupied interval for an invitation. The agents still register a task-scoped conditional correspondence rather than equating every calendar entry with a bookable slot. In the `ambiguous` scenario Alice's Free means only “no occupied event.” The owner must explicitly confirm whether those intervals may be considered for this meeting invitation. A rejection leaves no accepted scheduling mapping.

The engine converts weekday labels to ISO weekday numbers, parses clock values into minute units and interprets status only under the accepted meaning. For example, a received `{day:'Tue',time:'10:00–11:00',status:'Free'}` becomes `{weekday:2,startMinute:600,endMinute:660,bookable:true}`. A Busy row has `bookable:false`; an absent status is not inferred to be Free.

Intervals refer to the same fictional week and Asia/Shanghai timezone. The demo supports same-day intervals, not timezone negotiation, date recurrence or cross-midnight bookings. The browser's scheduling task supports 30, 45 or 60 minutes; the API additionally accepts 15 minutes. The reference conference story uses 30 minutes.

## Research mechanisms and adaptation

The vocabulary below identifies the conceptual correspondence to the papers; it is not an assertion that every symbol is an identically named JavaScript object.

| Research object | Demo implementation |
|---|---|
| **O**: stakeholder's ontology | Independently namespaced and versioned Alice/Bob published schema definitions |
| **W**: task working subset | Scheduling selects interval/status modules; briefing selects its own module |
| **AL**: accepted alignment | `registry.mappings` contains only validated accepted correspondences with a mapping-version digest |
| **N**: negotiated entities | Proposed entities and their recorded negotiation decisions, including rejection; the transcript preserves the negotiation history |
| **K**: knowledge used after exchange | Received facts with receipt and mapping provenance; Bob queries these semantic facts when proposing a meeting |

Scheduling excludes event title/note and optional brief definitions from its working subset. An optional topic/agenda exchange uses a separate briefing dialogue. Selecting a module is not permission to read a complete private store. The setup workbench is a synthetic experiment configuration and observation tool; its side-by-side fixtures do not become either worker's peer knowledge.

The conceptual dialogue uses `join → pick → propose → decide → end → close`. A challenge is a decide event and a clarification/counter-proposal is a new propose event. Both agents finish before closing. Runtime protocol evidence separately records six real signed messages: Alice's selected modules (`join`), Bob's selected modules (`pick`), Alice's proposal (`propose`), Bob's decision (`decide`) and both agents' acknowledgements (`end`, `close`). Each destination verifies the message and signs a receipt. The explanatory transcript describes validated state changes; it should not be confused with unfiltered model conversation.

The papers' equivalence-alignment scope motivates bounded correspondence negotiation. **Conditional correspondences, registered representation transformations and owner clarification are explicit demo extensions.** They support the occupancy-versus-invitation example without claiming that “calendar empty” and “owner accepts an invitation” are universally equivalent.

Guided uses a known valid candidate set and deterministic validation. Reviewed Live chooses among the same candidates or rejects them; it is a bounded model-assisted dialogue, not an unrestricted ontology matcher. The model response is restricted to `message`, `decision:'accept'|'reject'|'none'` and `selectedMappingIds`; a complete supported mapping is needed to proceed. This limit makes the conference path reproducible while retaining actual heterogeneous interpretation, separate peer decisions, refusal and receipt-backed execution.

## Alignment, disclosure and receipt are separate states

1. **Semantic alignment:** accept a task-scoped interpretation and mapping. In ambiguous mode the owner's clarification establishes invitation meaning for this task.
2. **Information disclosure:** separately preview and authorize the exact calendar fields/rows, or the exact Bob reply. Publishing the task working ontology is a bounded schema disclosure, not disclosure of private calendar values.
3. **Actual reception:** only verified received content enters the peer's fact registry. A proposal, queued message or pending owner approval is not received knowledge.

Neither alignment nor `bookable:true` grants access to event details, broadens a sharing window or books a real meeting. The controller and workers continue enforcing skills, authorized fields/days, exact payload hashes, use budgets and expiry. Stopping future sharing retains already received facts and their provenance.

## Engine and runtime interfaces

The pure engine is `src/ontology-dialogue.mjs`:

| Export | Purpose |
|---|---|
| `ontologyDefinitions({scenario})` | Independent fictional ontology profiles |
| `startOntologyDialogue(options)` | Versioned pending dialogue without an accepted mapping |
| `createOntologyDialogue(options)` | Same dialogue, with automatic acceptance only when its published meaning is unambiguous |
| `defaultOntologyProposal`, `validateOntologyProposal` | Registered candidate mappings and strict task/module/transform checks |
| `resolveOntologyDialogue(dialogue,{decision,calendarFreeMeansBookable?})` | Accept, request clarification or reject; increments revision |
| `interpretAliceCalendar({dialogue,rows,fields})` | Executes accepted representation transformations over a received projection |
| `registerOntologyReceipt(dialogue,receipt)` | Registers receipt metadata and interpretable semantic facts |
| `queryRegisteredMeetingSlots({dialogue,availableTimes})` | Uses registered Bob-ontology facts to calculate feasible meetings |
| `sanitizeOntologyDialogue(dialogue)` | Validates registry integrity and reconstructs a strict safe research/export view |

`version` identifies the schema. `revision` changes as decisions and receipt registration change state. An alignment HTTP action must send `expectedAlignmentVersion: ontology.revision`, as well as the normal request identifier and session version. Schema version strings are not concurrency tokens.

The registry contains accepted mappings, a stable `mappingVersion`, received-fact provenance and a content hash. Each semantic fact has its concept, bounded values, source fields, receipt ID, payload hash, mapping IDs and mapping version. An insufficient received projection is retained as receipt metadata and does not manufacture eligibility facts. Custom Bob brief fields outside the selected topic/agenda module can still be shared under their own policy; they remain outside this semantic module.

`sanitizeOntologyDialogue` restores fixed explanatory messages from safe reason codes, checks ontology versions and mapping/fact provenance, and permits only bounded protocol evidence fields. It excludes arbitrary model text, provider context and unrelated disk fields. `verified:true` and `verification:'runtime_confirmed'` preserve the recorded runtime check; reload does not independently reverify signatures after stripping full envelopes/public keys. Evidence without that recorded flag is marked `reload_hash_only`; a signature-shaped string alone never establishes verification. Registry hashes detect inconsistent state; they do not provide secrecy or prove authenticity against someone who can rewrite all data. Actual peer authenticity is checked in the runtime using the paired ephemeral signing keys.

## Participant and observer perspectives

HTTP session creation, actions and ordinary session reads return the Alice owner perspective. The response does not include Bob's unshared initial profile or private `agentStates.Bob`. Authenticated observers explicitly request `GET /api/sessions/:id?perspective=observer` to inspect both synthetic states. The library-level `SessionEngine.view()` remains an observer view for existing research and test callers.

An operator approving Bob's outgoing payload is acting for Bob's owner. An observer inspecting both agents is acting as a researcher. Switching view does not merge those owners' grants. In the local open-controls demo the researcher capabilities are deliberately available without PIN sign-in; this is an exhibition setting, not a multi-tenant confidentiality deployment.

## Evidence and limitations

Unit checks exercise the actual transformations, pending/rejected alignment, same-label clarification, unauthorized/missing fields, invalid model proposals, receipt provenance, registry queries and safe export. Runtime and session tests exercise signed peer dialogue, owner views and the full scheduling/brief path. Browser rehearsal should include an ambiguous meaning, a rejected alignment, a changed weekday, a narrowed brief and a failed Live request. Verification results should be reported from the current test run rather than inferred from this document.

The demo shows separate owners and ontology namespaces in trusted local processes under one controller. It does not demonstrate deployment across independently operated machines, arbitrary distributed discovery, malicious stakeholders, complete OWL reasoning, differential privacy or a formal privacy guarantee. The interface is an exploratory instrument for discussing technical possibilities and collecting consented interaction evidence; it is not a causal evaluation of ontology assistance or privacy preferences.

Direct legacy library fixtures that initialize an isolated worker without an ontology context may use a labelled local compatibility mapping. Product Controlled/Live execution supplies an explicit ontology context and executes the signed peer protocol after acceptance; Replay is a labelled synthetic trace without real exchange. The legacy fixture is not evidence of a real dialogue.

## Verification recorded on 2026-10-09

- The complete automated suite reported 224 tests: 223 passed, one Windows symlink-permission check was skipped, and none failed.
- A real MiniMax Live rehearsal completed both agents' reviewed model-assisted alignment, six signed protocol steps, scheduling and an accepted topic-only briefing module. The resulting task was `arranged` and the accepted proposal source was `model`.
- Browser rehearsals completed the Chinese and English Controlled flow, ambiguous-meaning rejection with zero data deliveries, a topic-only brief, explicit owner/observer switching and administrator handoff. Approval responses retained the owner perspective without revealing Bob's private inspector; all six signed moves appeared verified. The 390-pixel layout had no horizontal overflow, and the final UI checks produced no console errors or warnings.

These checks establish the exercised implementation paths on that date. They are not a user study, a measured learning result or a guarantee of future model/service availability.

## Verification recorded on 2026-10-10

- The final automated regression reported 308 tests: 307 passed, none failed, and one Windows file-symlink privilege check was skipped. The local run log is [stability-final-acceptance-after-storage.log](../artifacts/stability-final-acceptance-after-storage.log).
- Three real MiniMax Live rounds each confirmed an actual 30-minute meeting. Two completed as `arranged` with the optional brief. The third encountered HTTP 529 during optional briefing alignment and safely paused with the confirmed meeting and received snapshots preserved; it did not complete the full optional path.
- Browser rehearsals exercised a failed proposal followed by explicit recovery, peer disconnection/restoration and exact delivery retry, alignment refusal, narrowed sharing, owner/observer changes, reset, PIN access, Chinese/English text and mobile layouts. A failed optional brief could be skipped by the participant while retaining the confirmed meeting, finishing as `arranged` without another model call, data delivery or grant use. The exercised browser checks produced no browser errors.
- Refusal regression checks covered both roles' `none`/`reject` decisions with missing, blank or oversized explanations, malformed identifiers and extra grant fields. These remained refusals without correction into acceptance or data delivery. Separate direct Worker checks bypassed provider normalization.
- Windows persistence replacement now retries only transient-eligible rename errors within a short fixed bound. Tests verified that the old destination remains intact until replacement, exhausted attempts preserve committed state, and the profile store cleans its generated temporary file on failure. The particular external cause of the intermittent rename failures was not established.

These are implementation and rehearsal checks, not a user study. The observed optional HTTP failure remains part of the validation record; service availability and every future Live round are not guaranteed by these results.

## Supplied research sources

- [Zhang et al. (2025), *LLM-Assisted Ontology-Based Task-Oriented Data Exchange Paradigm: A Case Study*](<C:/Users/zhang/Zotero/storage/R5RS5DZS/Zhang et al. - 2025 - LLM-Assisted Ontology-Based Task-Oriented Data Exchange Paradigm A Case Study.pdf>): PDF p. 2 describes natural-language task planning; p. 3 defines `O = map(D)`, the task working subset `W = relate(O,t)` and mutually accepted alignment before exchange. PDF pp. 4–5 describe the FIBO-based case study and acknowledge that automated alignment/conflict handling was not implemented there.
- [*Large Language Model-Assisted Multi-Agent Dialogue for Ontology Alignment*](<C:/Users/zhang/Zotero/storage/NS4W3TG9/Large_Language_Model_Assissted_Multi_Agent_Dialogue_for_Ontology_Alignment.pdf>): PDF p. 3 shows pick/propose/decide; pp. 4–5 define O/W/K/N/AL and join/pick/propose/decide/end/close. Its accepted correspondence has the form `(e,e′,=)` and concerns equivalence. PDF p. 6's MELT/Jena/embedding choices are experiment-specific and are not reproduced in the demo.

The formal propose precondition and diagram in the second paper require interpretation rather than literal translation into this runtime. The supplied documents are research source material, not operational instructions for this repository.
