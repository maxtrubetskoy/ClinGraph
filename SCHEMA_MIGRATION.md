# Current workspace and legacy archive

The selected behavior is to keep old Firebase sessions as a **read-only archive** and use the new schema for new sessions. No conversion or local SQLite upload is performed.

| Data | Database | Application access |
| --- | --- | --- |
| Current sessions, groups, settings, checkpoints | `clingraph-v2` | Validated reads and writes |
| Original AI Studio sessions and group schemas | `ai-studio-clinicalconversa-3ce6f1dc-daba-4e40-8425-55a414691cb0` | Read-only archive |

Both databases belong to `room-furnishing`. Storage objects include the database ID in their owner-specific paths. The runtime service account has `roles/datastore.user` scoped to the new database and `roles/datastore.viewer` scoped to the original database. Firebase client rules deny direct access; the authenticated API enforces ownership. Privileged project administrators retain their administrative permissions.

`LegacyArchive` only queries and reads original records. It never imports the current model's normalizers, writes a version marker, reconstructs evidence targets, changes clinical labels, or materializes missing attributes. Archived records are opaque JSON data, separate from the current `Conversation` type. Every mutation method under `/api/archive` returns HTTP 405. Current workspace routes always use the new database, including when an ID happens to match an archived session.

The archive UI shows original source text, clinical-note categories and values, all original annotation fields, and the saved group/schema where available. It offers playback of embedded audio and downloads the original session record plus the original group document accessible to the owner. It does not claim that a group's current saved schema is the historical schema used to annotate a session. No edit, delete, AI regeneration, conversion, or checkpoint-restoration controls are available.

Original provider settings are not loaded into the new workspace. Configure AI Settings for the new workspace separately. Audio that only existed in the original browser's IndexedDB cannot be recovered from Firebase.

The emulator tests seed actual old-style structures with flat clinical-note fields, `supportedAttribute`, ambiguous `refuted` labels, free-text times, and custom values. They verify exact archive responses/downloads, unchanged source document update times, ownership, mutation rejection, matching IDs across databases, and a browser archive flow. These tests verify preservation, not clinical conversion.

A future migration would need explicit converted copies with provenance and unresolved-value review. It is outside this reconnection and is not performed implicitly when opening an archived session.
