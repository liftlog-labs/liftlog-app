# Workout experience — current scope

Approved by the user on 2026-11-23. These are current product requirements, not claims of implementation. This update supersedes earlier deferrals of daily planning, progression and the features below. Detailed migrations and interfaces must be designed against the current code before implementation.

## Product decisions

Continue an agreed plan by default; adapt it transparently instead of generating an unrelated routine every day. Explain recommendations with specific saved evidence and acknowledge gaps. Let users inspect and correct goals, preferences and remembered facts. Preserve manual/offline logging when AI or hosting fails. Keep onboarding short, sync automatic and unobtrusive, and workout-time questions minimal. No new permission to retain full transcripts or upload HealthKit data is implied.

## Required features and acceptance

| Feature | Required behavior and acceptance |
|---|---|
| Today's workout | Home shows the next agreed session, a brief evidence-based rationale, estimated duration and Start workout. Offer shorter-session and rest options without treating rest as failure. Estimates are labeled, not presented as measurements. Resume an open workout instead of creating another. |
| Editable daily plans and weekly split | Exercises, ordered target sets, rep ranges and rest periods are editable before acceptance. Persist accepted plans and revisions separately from performed sets. Acceptance creates no performed sets, volume or PRs. Revisions never overwrite completed work. Use schedule, goal, equipment and preferences to propose a sustainable split. |
| Fast logging | Show last comparable performance, repeat a prior set through an explicit action, adjust load/reps and undo a newly saved set. Distinguish equipment/load conventions and unknown history. Prevent duplicate writes on retries. Chat complements direct controls. |
| Rest timer and session resume | Offer a timer after a committed set, with skip/adjust controls. Persist sufficient timing/session state to recover after close/reopen without relying on background execution. Do not restart or duplicate timers on sync replay. Define expiry and clock-change behavior; notifications require a separate permission and are not required for the first timer. Preserve unfinished workout and completed sets. |
| Equipment-aware swaps | Offer alternatives by movement purpose, available equipment and explicit limitations. Explain why a swap fits. Confirm a change to planned targets; never relabel performed history or transfer load equivalence between machines/exercises. Unknown starting load remains unknown. |
| Optional effort | Support simple effort feedback or reps in reserve. Store which scale the user actually supplied; do not invent exact RIR from easy/about right/very hard. Missing effort remains unknown. Include changes in backup/sync/context contracts when implemented. |
| Weekly review | Summarize logged sessions and comparable performance changes, cite the supporting records and suggest a next adjustment. State incomplete coverage. Missing logs are not missed workouts. A proposed change requires acceptance and never alters history. |

## Delivery sequence

1. Finish the bounded $0 hosting feasibility work and stabilize Coach sparse-history/follow-up behavior. Neither proves production readiness.
2. Design and build separate plan/target persistence with sync, backup and deletion semantics; add editable daily sessions, agreed weekly sequence and Today's workout.
3. Improve direct logging, effort capture, rest timer and resume. Reuse existing last-time/undo/resume behavior where already implemented rather than rebuilding it. These local improvements can proceed independently of hosting.
4. Add equipment-aware swaps against the plan model.
5. Add reviewed comparable-performance progression rules and the weekly review. Keep uncertain recommendations explicit and user-controlled.
6. Complete deployment/recovery/security gates and standalone release packaging before wider use.

For each slice: first inspect existing implementation; define bounded acceptance cases; preserve account isolation, automatic sync, consent, tombstones and planned/performed separation. Run relevant automated checks sequentially plus lint/typecheck. Do not launch simulators/emulators/device UI; the user performs manual checks from a short checklist.

## Hosting and publication constraints

Strict $0 recurring hosting budget; no paid service/trial/upgrade is approved. The stock Vercel Python probe failed with node_missing; its temporary project was removed. A container probe is a candidate only: verify actual Hobby availability, pricing, runtime restrictions and the exact artifact before requesting separate upload approval. Do not assume it is supported or free. No Supabase provisioning or full app publication is implied.

Include a sanitized GitHub repository/publication task in the next development handoff, as requested earlier. Do not push private history or create/push a repository in this documentation task. Review the existing publication plan and secret/private-data scan first.

## Still outside this expansion

Food-photo analysis, social feeds, wearable integrations, camera form assessment and per-user model training remain deferred. This update does not authorize paid hosting, public deployment or new health-data processing.
