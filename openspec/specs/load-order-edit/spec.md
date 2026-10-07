# Spec: load-order-edit

## Purpose

Let users move a whole mod's positioned actions as a block inside the global load order, with honest fit reporting, from the evolved overrides editor.

## Requirements

### Requirement: Editor lives on overrides route, view stays read-only
The system SHALL keep `#/load-order` free of any control that changes a value, and SHALL host all editing on `#/load-overrides`.

#### Scenario: View cannot write
- **WHEN** a user opens `#/load-order`
- **THEN** no button, input, or drag on that page writes `LoadOrder` (navigating to `#/load-overrides` is allowed).

#### Scenario: Editor entry from view
- **WHEN** a user picks Override on a load-order row
- **THEN** the system opens `#/load-overrides` with that mod and action pre-selected.

### Requirement: Mod-first collapsed picker
The system SHALL present mods collapsed by default, each showing positioned count, min, max, width, tie flag, undeclared count, and protected flag, and SHALL exclude undeclared actions from any block move.

#### Scenario: Overhaul with wide spread
- **WHEN** a user expands an overhaul mod with actions at 100, 200, and 300
- **THEN** the row shows min 100, max 300, width 200, and the undeclared actions listed separately with no proposed value.

#### Scenario: Undeclared never auto-assigned
- **WHEN** a block move is proposed
- **THEN** no undeclared action receives a new value unless the user explicitly picks that action in manual mode.

### Requirement: Anchor or free-band target
The system SHALL allow targeting before/after a value or mod band, or a free band from the profile's own bands.

#### Scenario: Place after overhaul
- **WHEN** a user targets after Overhaul B's max
- **THEN** the proposal uses the first free run at or after that anchor.

### Requirement: Fit preserves offsets
The system SHALL, when the target gap fits the block width, propose `new = base + offset` preserving internal spread and order.

#### Scenario: Fitting move
- **WHEN** a width-200 block targets a gap of 500 free values
- **THEN** every proposed value equals base plus its original offset and order is unchanged.

### Requirement: No-fit reports and offers three paths
The system SHALL block auto-placement when width exceeds the gap and SHALL offer even re-space, overflow, and manual, with need-vs-gap numbers shown.

#### Scenario: Too-wide block
- **WHEN** a width-200 block targets a 50-value gap
- **THEN** the system reports need 200 vs gap 50 and offers the three options without writing anything.

#### Scenario: Even re-space
- **WHEN** a user accepts even re-space in a gap
- **THEN** the proposal keeps action order and distributes values evenly inside the gap, showing the old-to-new table.

#### Scenario: Overflow
- **WHEN** a user accepts overflow below min or into headroom
- **THEN** the proposal places the block outside the occupied range and warns when any value reaches sentinel load-last range.

#### Scenario: Manual fallback
- **WHEN** a user picks manual
- **THEN** the system allows per-action whole-number entry with free-band hints and validates each value.

### Requirement: Atomic apply with game guard
The system SHALL apply a block move in one transaction with one backup, writing value plus stamp together, and SHALL refuse while Civilization VI runs.

#### Scenario: Block apply
- **WHEN** a user applies a 40-action block move
- **THEN** either all 40 values plus stamps land with one backup, or none land.

#### Scenario: Game running
- **WHEN** Civilization VI holds the database open
- **THEN** the apply is refused with a reason and nothing is written.

### Requirement: Honest warnings
The system SHALL warn (never silently decide) when a proposal creates or enlarges a tie, touches a misspelled property, touches an unprotectable base/DLC row, applies over drift, or enters sentinel range.

#### Scenario: Tie warning
- **WHEN** a proposal lands on an occupied value
- **THEN** the UI states the result is a tie the game picks arbitrarily.

#### Scenario: Unprotectable row
- **WHEN** a proposal includes a base-game or DLC action with no `.modinfo` on disk
- **THEN** the row is marked not protected.

### Requirement: No invented ordering or conflicts
The system SHALL never infer conflicts from shared filenames, SHALL never order actions inside a tie, and SHALL never gate editing on undecidable criteria.

#### Scenario: Shared file is not a conflict
- **WHEN** 55 mods share `Localization.xml`
- **THEN** the editor shows no conflict warning for that sharing.

### Requirement: Global order, profile is a filter
The system SHALL treat overrides as global per action and SHALL treat the profile selector as a subset filter that never triggers writes on switch.

#### Scenario: Switch profile
- **WHEN** a user switches profile in the editor
- **THEN** the visible subset changes and nothing is written.

### Requirement: Identity by componentRowId with server resolution
The system SHALL identify picked actions by `componentRowId` and resolve via the server, reporting orphaned or ambiguous keys without writing.

#### Scenario: Stale action
- **WHEN** a stored key matches zero or multiple actions
- **THEN** the entry shows orphaned or ambiguous with its reason and offers only discard.
