# Spec: game-setup

## Purpose

Let players assert the game setup they actually play with — rulesets, game modes, config values — so gated actions get real will-run verdicts instead of permanent "requires it" rows.

## Requirements

### Requirement: Option catalog mined from the library
The system SHALL list exactly the rulesets, game modes, and config values the installed library gates on (from CriterionProperties), each with a proper display name, and SHALL list nothing the library never checks.

#### Scenario: Catalog matches the library
- **WHEN** the library gates on GAMEMODE_MONOPOLIES and RULESET_EXPANSION_2 and nothing else
- **THEN** the panel offers exactly those two options, by readable names.

### Requirement: Round toggles assert setup
The system SHALL offer each option as a round toggle; toggling on asserts that value for verdict purposes, toggling off withdraws it.

#### Scenario: Enabling a game mode
- **WHEN** the player enables Monopolies mode
- **THEN** actions gated on GAMEMODE_MONOPOLIES stop showing "requires it".

### Requirement: Assumed verdicts labeled assumed
The system SHALL mark every verdict that depends on an asserted option as assumed, in the view and in replay gating — never presenting it as measured. (The override editor renders no verdicts, so there is nothing to mark there.)

#### Scenario: Assumed row distinguished
- **WHEN** an action runs only because Monopolies mode is asserted
- **THEN** its row says so explicitly, visually distinct from measured will-run rows.

### Requirement: Global store, no game writes
The system SHALL persist asserted setup in a global JSON store (game setup is per game start, not per profile) and SHALL never write the game database for it; deleting the store returns all verdicts to measured-only.

#### Scenario: Store removed
- **WHEN** the store file is deleted
- **THEN** every gated row returns to its undecided wording with nothing else changed.
