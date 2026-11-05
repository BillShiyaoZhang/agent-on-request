# Research application profiles

`baseline.json` defines the common personal and academic application vocabulary. `alice.json` adds knowledge-graph research, semantic-artifact and experimental-evidence modules; `bob.json` adds HCI research, interaction, study and finding modules. Their fictional records are connected research knowledge, not interchangeable copies of a calendar schema. `conference.json` and `mappings.json` define the synthetic conference and bounded correspondence candidates.

`src/research-profiles.mjs` qualifies every type, relationship and instance into the owning role namespace and computes a canonical SHA-256 ontology digest. Every call returns independent data. `validateResearchProfile` checks module and inheritance closure, property types, relationship endpoints, evidence references, material classification and skill dependencies. `selectWorkingOntology` accepts an actual exported profile as its third argument, so a native KG profile can replace the packaged starting definitions.

The native adapter installs the existing KG `personal` preset, adds concrete editable research types/properties/relationships with `OntologyEditor`, and writes typed entities and edges. Subsequent profile exports read labels, definitions, datatype constraints, endpoint constraints and data from the current native KG. The service-managed `ResearchProfilePackage` bootstrap record retains module grouping, class-parent annotations, storage bindings and the original public-material certificates. It is not an ordinary `KGEntity` writable by the agent memory tools.

The current KG overlay has no editable inheritance or array-shaped custom properties. The adapter flattens inherited property/relationship constraints into their native domains; logical string arrays use explicitly decoded JSON-string storage. It preserves class-parent annotations in the exported application profile and does not claim to run a general OWL reasoner. A studied `OntologyArtifactVersion` remains a data object and never changes the agent's application schema.

Knowledge written during an experience uses private, workspace-specific native URIs. It is excluded from the starting profile for the next visitor. A modified or newly created native material defaults to private unless its exact fields and version still match a service-seeded public certificate. Ordinary `Decision`, `ParticipantConsentRecord`, `HumanCompetency`, agent skill instructions and KG authorization projections never grant execution authority.

The native profile endpoints require the role's service credential:

- `GET /api/research/profile` exports the actual native profile and provenance.
- `PUT /api/research/profile` seeds additively with `seedOnly:true`; existing definitions/data are preserved. An explicit replacement also requires the reviewed `expectedRevision`.
- `POST /api/research/knowledge` records typed private nodes/edges within `workspaceId`.
- `POST /api/research/projections` projects a ledger event idempotently for discovery; responses include `authority:false`.

Run `node --test test/research-profiles.test.mjs test/research-kg-client.test.mjs`. With the adjacent KG plugin and its console dependencies installed, `python docker/kg/test-research-adapter.py` validates adapter output against the actual native ontology constraints without needing Neo4j.
