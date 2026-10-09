# Multiple targets for one mention

The patient's “die” can refer to Cellcept and Prednison. Keep one mention ID, span,
and discourse context, with independently editable evidence links to both entities.
The same mechanism supports an attribute on each entity without promoting attribute
evidence to whole-entity claims. Linking never changes the mention's role or context.

Compatibility: existing single-target mentions keep `target` and `entityId`. A shared
mention has an authoritative `targets` array, with the singular fields null. Normalize
back to the original form when only one link remains. Targets are unique by entity;
each entity has either direct evidence or one attribute target for this span. Reject
dangling/foreign attribute links. An explicit empty target list means unlinked.

Implementation sequence:

1. Add tests for the Dutch example: normalization, independent linking/unlinking,
   same-span identity/context, strict validation, persistence, checkpoints and exports.
   Implement shared target helpers and update graph/export/context/realignment consumers.
2. Update AI mapping to retain repeated mention IDs across distinct entities, while
   isolating conflicting assignments within one entity and preserving other valid links.
   Update extraction/mapping prompts and tests, including the 120-mention regression.
3. Add a reusable target editor in source inspection and clinical notes. Users can
   add an entity, choose its evidence target, and remove a link. Lists/highlights include
   the mention under every linked entity; deleting an entity preserves other links and
   the source mention. Graph clicks select the owner of the clicked evidence edge.
4. Browser-test linking “die” to Cellcept and Prednison, independently editing/removing
   links, reload, export and entity deletion. Run unit/API/browser suites, typecheck,
   build and code review. Commit/push only this feature and its documentation.

Review focus: old single-target payloads; mixed direct/attribute evidence; malformed
target arrays; deletion and legacy status migration preserving other links; source
identity/context and export cardinality; AI partial failures remain isolated.
