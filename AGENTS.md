# Frontend development for the patient management fork

Apply these instructions when implementing the ClinGraphCare patient management fork described in [the design spec](docs/superpowers/specs/2026-10-04-patient-management-design.md). Carry this file into the fork.

## Design skills

Use `frontend-design` from `anthropics/skills` when designing or implementing frontend screens and components. Its installed instructions are at `~/.codex/skills/frontend-design/SKILL.md`. Establish and document a compact palette, typography, spacing, component states, and layout direction before building the screens.

Use `web-design-guidelines` from `vercel-labs/agent-skills` to review each completed frontend change. Its installed instructions are at `~/.codex/skills/web-design-guidelines/SKILL.md`. Fetch the current guideline document as instructed and review the specific changed frontend files; the scope of the review is already supplied by the change. Use an available web-fetch tool when the skill refers to WebFetch.

Follow the user's requirements and the approved project design when a general skill recommendation differs from the clinical workflow.

## Product design context

Clinicians work with shared patient records, consultation evidence, documents, and draft review. Patients read their own registered vitals and concerns. Give the clinician workspace efficient navigation and a clear comparison between evidence and findings. Give the patient portal a calm, readable layout suited to phones and varying levels of health literacy.

Keep **Review** and **Register in patient record** distinct. Show clinical dates, units, provenance, uncertainty, and correction history clearly. Patient views contain registered content only. Use sentence case and specific action labels throughout these portals.

Charts need readable labels and an equivalent data list or table. Clinical status and measurement meaning must never rely on color alone. Preserve unknown dates and units in the interface rather than making the display look complete by inventing them.

## Frontend verification

Review desktop and mobile screenshots, keyboard navigation, visible focus, labels, form errors, loading and empty states, reduced motion, browser zoom, and long clinical content. Check that dialogs and sticky controls leave focused elements visible. Fix findings in the changed files and confirm the affected workflows before declaring frontend work complete.
