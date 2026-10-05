# Spec: replay-text-tables

## Purpose

Stop the replay from manufacturing findings out of its own missing localization tables, while keeping genuine text errors visible through a minimal-schema text replay.

## Requirements

### Requirement: Localization-table misses are environmental, not findings
The system SHALL skip per-file rows for `no such table` errors naming localization tables (LocalizedText, EnglishText, BaseGameText and kin) and SHALL state the skip once per replay instead.

#### Scenario: Text file hits missing table
- **WHEN** a text file's statement fails only because its localization table is absent from the gameplay copy
- **THEN** no per-file row appears, and one note states the skip with the table set.

### Requirement: Text files replay against a minimal text schema
The system SHALL replay text-targeting files against an empty database carrying just the localization tables with correct keys, so syntax failures and mod-vs-mod duplicate tags surface; missing-vs-base and dead-text detection stay out of scope.

#### Scenario: Genuine text error surfaces
- **WHEN** a text file carries a real error (bad statement, duplicate key across mods)
- **THEN** it reports as a normal finding with file and statement.

#### Scenario: Same-mod text duplication tagged
- **WHEN** duplicate tags come from one mod's own files
- **THEN** the finding carries the same-mod tag like collision rows do.
