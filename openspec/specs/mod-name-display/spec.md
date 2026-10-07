# Spec: mod-name-display

## Purpose

Make every mod name in the toolkit display the way the mod manager shows it: Civ markup rendered, never raw tags or raw localization keys, in pages, dropdowns, and dialogs alike.

## Requirements

### Requirement: Page HTML renders mod names
The system SHALL render mod names as HTML everywhere names appear in page content, so Civ markup never shows as literal text.

#### Scenario: Undeclared block
- **WHEN** a mod named `[COLOR_LIGHTBLUE]Advanced Cheat Menu (Light)[ENDCOLOR]` appears in the load order undeclared block
- **THEN** it displays as `Advanced Cheat Menu (Light)` with no visible bracket tags.

#### Scenario: Editor warnings
- **WHEN** a warning names a mod carrying Civ markup
- **THEN** the warning shows the rendered name with no visible bracket tags.

### Requirement: Plain-text contexts strip markup
The system SHALL show plain stripped mod names (no bracket tags, no HTML) in `<option>` dropdown text and native `confirm()`/`prompt()` dialogs.

#### Scenario: Move-a-mod dropdown
- **WHEN** a marked-up mod appears in the anchor-mod dropdown
- **THEN** the option reads as plain text with no visible tags and no HTML source.

#### Scenario: Profile switch preview
- **WHEN** the profile switch preview names a marked-up mod in its confirm dialog
- **THEN** the dialog shows the plain name with no visible tags.

### Requirement: Ledger resolves localization tags
The system SHALL resolve `LOC_` name tags in the overrides ledger, so no raw localization key is shown.

#### Scenario: Tagged mod in ledger
- **WHEN** a stored override belongs to a mod whose name is a `LOC_` tag with English text available
- **THEN** the ledger shows the resolved text, not the raw tag.

### Requirement: Regression coverage in the release gate
The system SHALL fail the release gate when a new page-HTML spot interpolates a mod name without rendering, or a dialog/option spot interpolates one without stripping.

#### Scenario: New leak introduced
- **WHEN** a change adds a page-HTML interpolation of a mod name through plain escaping
- **THEN** the release gate fails with the offending location named.
