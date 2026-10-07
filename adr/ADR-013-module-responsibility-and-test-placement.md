# Decision: module responsibility and test placement doctrine

## Summary

**Status:** Accepted
**Date:** 2026-10-07
**Scope:** product module splits and test-mirror placement in every capability with mirrored or extracted code
**Applies to:** `load-order-edit`, `conflict-replay`, `shadowing-enumeration`, `game-setup`, `log-pairing`
**Change:** Implemented by doctrine adoption 2026-10-07

**Decision:** We will hold three doctrines on every restructure: net first (coverage over touched code before the move), no test logic in product modules (cutover deletes the old harness in the same program), and one responsibility per module with a single owner for shared constants.

**Trade-offs:**

- Accepted: stricter upfront work — characterization tests or mirrors are written before the restructure pays back, so small splits cost more than the move alone.
- Accepted: cutover discipline — the old harness is deleted in the same program that replaces it, so a change carries both the new shape and the removal.
- Cost: tiny Tier 0 fixes need no ceremony — ≤2 files, no new behavior, one `test:<what>` run; the escape hatch is the existing Tier 0 definition, not a waiver to argue.

## Context

The mirror waves (1-to-4) covered phase scripts before the server split moved any product code; the refactor program then split along existing section banners (gates, store, fit) with shared constants owned once. The replay extraction showed the failure mode on both sides: product code (`src/server.js:31`) required a proof file, and the lib carried 9 dead `run*` suites after the mirror replaced them. Each case resolved the same way — prove equivalence first, move second, delete the replaced shape in the same program.

## Options Considered

### Adopt all three doctrines (chosen)

- Pros: restructures arrive with a net already up; product modules never accumulate harness code; shared constants have one owner, so no duplication and no require cycles.
- Cons: upfront characterization work on code about to move; cutover deletions widen the diff.
- Chosen because: the waves-1-to-4-then-refactor sequence, the replay-lib extraction, and the gates/store/fit splits each already followed it — this records the precedent, not a new process.

### Restructure first, cover after (rejected)

- Pros: smallest diff per change; momentum.
- Cons: the move itself is unproven — equivalence is asserted, not executed; regressions surface in the gate instead of the wave.
- Rejected because: it inverts the sequence that made the mirror waves safe (dual-run proves equivalence before the swap).

### Leave the old harness alongside the new one (rejected)

- Pros: zero deletion risk; rollback is a revert of one require line.
- Cons: dead suites rot in product-adjacent files; the next reader cannot tell which shape is live (the 9 dead `run*` suites in the replay lib).
- Rejected because: cutover discipline — when the gate moves, the old harness is deleted in the same program, never left as dead weight.

### Duplicate shared constants per module (rejected)

- Pros: no cross-module coordination; each split lands independently.
- Cons: two owners for one truth; drift between copies; require-cycle temptation when copies grow imports to stay in sync.
- Rejected because: shared constants get exactly one owning module — split along existing section banners, reference across, never copy.

## Consequences

No product-code restructuring without automated coverage over the touched code — characterization tests or mirrors first, move second. Self-tests living in product code is a smell; when the gate moves, the old harness is deleted in the same program (cutover discipline), never left as dead weight. Modules split along existing section banners; shared constants get exactly one owning module — no duplication, no require cycles. Known cost: stricter upfront work on every split. Escape hatch: tiny Tier 0 fixes (≤2 files, no new behavior, one `test:<what>` run) need no ceremony. A future change revises this doctrine only by superseding this decision with a new decision file — never by editing this file.

## Change

Implemented by doctrine adoption 2026-10-07. No OpenSpec change exists for this decision, and none is invented here — there is no proposal, design, or tasks file behind it, only the precedent programs named above.
