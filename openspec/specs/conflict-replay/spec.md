# Spec: conflict-replay

## Purpose

Diagnoses database-level mod conflicts by replaying mods' SQL writes in load order against a disposable copy and reporting exactly which file and statement wins each contested row and column.

## Requirements

### Requirement: Replay into temp copies only, never the live game DB
The system SHALL execute conflict replay exclusively against a temporary copy of DebugGameplay.sqlite and SHALL never open the live game database for writing.

#### Scenario: Replay leaves live DB untouched
- **WHEN** a user runs a conflict replay over any mod set
- **THEN** the live game database file is unmodified (replay reads go to the temp copy) and the report names the temp copy used.

#### Scenario: Game running does not block diagnosis
- **WHEN** Civilization VI holds the live database open
- **THEN** replay still proceeds against the temp copy without requiring the game to close.

### Requirement: Ordered replay with per-file abort emulation
The system SHALL replay statements in global load order (mod order, then file order, then statement order) and SHALL emulate the game's per-file abort semantics with per-file SAVEPOINTs so a failing statement rolls back only its own file's statements.

#### Scenario: File abort contained
- **WHEN** one statement in a file fails during replay
- **THEN** only that file's statements are rolled back and replay continues with the next file in order.

#### Scenario: Cross-file order preserved
- **WHEN** two files from different mods write the same row
- **THEN** the later file in load order wins the replayed value, matching last-writer-wins.

### Requirement: Row and column provenance for every contested cell
The system SHALL record (table, primary key, column) → (source file, statement index) provenance for every write during replay and SHALL name the winning and losing file plus statement for each contested cell in the collision report.

#### Scenario: Contested cell names winner and loser
- **WHEN** two mods update the same column of the same row
- **THEN** the report names the table, key, column, winning file and statement, and losing file and statement.

#### Scenario: Uncontested writes carry no collision
- **WHEN** a cell is written by exactly one statement in the replay
- **THEN** the report lists no collision for that cell.

### Requirement: Differential validation against Database.log
The system SHALL compare the replay outcome against Database.log and SHALL report agreement plus every divergence class (error the game logged that replay missed, error replay raised that the game did not log) with the offending file and statement.

#### Scenario: Agreement reported
- **WHEN** replay errors match Database.log errors for a mod set
- **THEN** the report states agreement and names the log lines matched.

#### Scenario: Divergence named explicitly
- **WHEN** replay raises an error absent from Database.log, or vice versa
- **THEN** the report lists the divergence with file, statement, and which side observed it.

### Requirement: Harness gaps handled or declared, never silent
The system SHALL handle or explicitly declare each known replay-fidelity gap: FK on/off mode choice, Make_Hash JS stub, double-quoted-string rewrite, trigger-aware statement splitting, XML→SQL conversion (~5% of files), same-LoadOrder tie-breaks, and criteria gating — and SHALL mark any collision whose fidelity is limited by one of these.

#### Scenario: Unsupported construct flagged
- **WHEN** a replayed file needs the Make_Hash stub, double-quoted-string rewrite, or XML→SQL conversion to execute
- **THEN** the report marks affected collisions with the limitation applied.

#### Scenario: Criteria-gated writes evaluated
- **WHEN** an action carries ActionCriteria gating
- **THEN** replay evaluates the gate and reports which gated writes were skipped and why.

### Requirement: Reference performance envelope
The system SHALL replay a reference-scale mod (8,138 statements) into a temp copy in on the order of ~2s (~3,700 statements/s) with at least 9 in 10 statements executing under FK-off, and SHALL report statement counts, execution rate, and skip rate with every replay.

#### Scenario: Envelope reported
- **WHEN** a replay completes
- **THEN** the report states statements replayed, wall-clock time, statements/s, and the executed-vs-skipped fraction.
