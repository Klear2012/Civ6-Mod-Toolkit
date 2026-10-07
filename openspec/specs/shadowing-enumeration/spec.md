# Spec: shadowing-enumeration

## Purpose

Enumerates every UI file path claimed by more than one enabled mod and honestly reports which path has a decidable winner and which is undefined, including script replacements invisible to the file list.

## Requirements

### Requirement: Enumerate all contested UI paths including LuaReplace
The system SHALL enumerate every UI path claimed by more than one enabled mod, sourcing file claims from Components/Files and script-replacement claims from ComponentProperties.LuaReplace (which has zero ComponentFiles links), and SHALL list every claimant mod per contested path.

#### Scenario: ReplaceUIScript target enumerated
- **WHEN** a mod declares a ReplaceUIScript action whose LuaReplace target is also shipped or replaced by another mod
- **THEN** the contested path lists all claimant mods including the ReplaceUIScript claimant, with its source marked as LuaReplace.

#### Scenario: Uncontested paths omitted
- **WHEN** a UI path is claimed by exactly one enabled mod
- **THEN** it does not appear in the contested-path report.

### Requirement: Winners decided only by max declared LoadOrder
The system SHALL declare a winner for a contested path only when exactly one claimant declares the strictly greatest LoadOrder value, and SHALL classify every other contested path as undefined with its reason (no claimant declares order, or genuine tie on the max value).

#### Scenario: Single max wins
- **WHEN** a contested path has claimants with declared LoadOrder values and one is strictly greatest
- **THEN** the report names that claimant as the winner with its declared value.

#### Scenario: No declared order is undefined
- **WHEN** no claimant of a contested path declares a LoadOrder value
- **THEN** the report marks the path undefined with reason no-declared-order and names all claimants.

#### Scenario: Genuine tie is undefined
- **WHEN** two or more claimants share the same greatest declared LoadOrder value
- **THEN** the report marks the path undefined with reason tie and names the tied claimants and value.

### Requirement: Undefined winners reported, never picked
The system SHALL never select, rank, or imply a winner for an undefined path by any secondary signal, including content hashing, filename heuristics, or mod installation order.

#### Scenario: Identical content still undefined
- **WHEN** all claimants of a contested path ship byte-identical content
- **THEN** the path is still reported undefined (with its underlying reason) and no winner is named.

#### Scenario: No silent ordering inside ties
- **WHEN** a contested path is a genuine tie
- **THEN** the report lists tied claimants without ranking them.

### Requirement: Reference corpus shape and performance envelope
The system SHALL enumerate shadowing over a reference-scale corpus (424 mods / 3,171 components) in on the order of ~50ms and SHALL report totals: contested path count, decidable count, undefined-by-no-declared-order count, and tie count (reference shape: 354 contested, 35 decidable, 318 undeclared, 1 tie).

#### Scenario: Envelope reported
- **WHEN** an enumeration completes
- **THEN** the report states component count, contested count, decidable count, undefined count with reasons, and wall-clock time.
