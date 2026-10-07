# Spec: log-pairing

## Purpose

Tell the player which mod is responsible for each game database error, so nobody matches timestamps across two logs by hand again.

## Requirements

### Requirement: Multi-line error attribution from Database.log context
The system SHALL join each Database.log ERROR with its same-timestamp context lines (executing statement, row values, source file path) and SHALL attribute the error to the mod owning that file via the workshop-ID/folder mapping.

#### Scenario: Workshop file error attributed
- **WHEN** a Database.log ERROR has same-timestamp context naming a workshop file path
- **THEN** the report names the owning mod, file, statement, and row values.

#### Scenario: Context without workshop path
- **WHEN** context lines name a base-game or local file instead
- **THEN** the report attributes to base game or resolves the local mod by folder, never leaving the path unmapped without saying so.

### Requirement: File-hint fallback preserved
The system SHALL keep basename file-hint matching for errors with no usable context lines.

#### Scenario: Hint-only error
- **WHEN** an ERROR has no same-timestamp context but names a file token
- **THEN** attribution falls back to file-hint matching as today.

### Requirement: Modding.log bracketing labeled approximate
The system SHALL attribute hint-less, context-less errors to whatever Modding.log shows loading at the nearest preceding timestamp, and SHALL label such attributions approximate.

#### Scenario: Bracketed error marked approximate
- **WHEN** an error has neither context nor file hint
- **THEN** the report names the nearest-preceding loading file's mod with an explicit approximate marker, or states that no loading line precedes it.

### Requirement: Load timeline feeds ordering calibration
The system SHALL derive the game's actual file load sequence from Modding.log Loading lines and SHALL report where it differs from the assumed replay order.

#### Scenario: Order divergence reported
- **WHEN** the game loaded two files in the opposite order to the replay assumption
- **THEN** the calibration lists the pair and which side each order came from.

### Requirement: Differential grouped by responsible mod
The system SHALL group differential rows under their responsible mod with per-mod counts, ordered attributed before unattributed, and SHALL offer a toggle hiding unattributed rows.

#### Scenario: Same failure repeated across files
- **WHEN** one mod's three language files fail with the same missing-table error
- **THEN** they appear as one mod group reading as one finding, not three separate rows.

#### Scenario: Unattributed hidden on request
- **WHEN** the user enables hide-unattributed
- **THEN** unattributed rows disappear and the counts say how many are hidden.

### Requirement: Differential searchable by mod
The system SHALL offer an exact-match mod search over differential groups, reusing the load-order exact-match pattern.

#### Scenario: Search names a mod
- **WHEN** the user types a mod's full display name
- **THEN** only that mod's group shows, with an explicit empty state otherwise.

### Requirement: Plain-language differential and gated-out sections
The system SHALL label every differential and gated-out row in average-player words, with tooltips answering what to do next, and SHALL show mod display names everywhere — never raw IDs, GUIDs, or contradictory strength labels.

#### Scenario: Gated-out row names the mod
- **WHEN** a gated-out file belongs to a known mod
- **THEN** the row names the mod's display name, not its mod id.

#### Scenario: No contradictory labels
- **WHEN** a row is unattributed
- **THEN** it carries no strength label implying attribution.
