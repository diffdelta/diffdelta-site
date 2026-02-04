# DiffDelta Technical Specification

## Core Objective
To provide a normalized, bot-first changefeed (JSON) that minimizes token waste through semantic summarization and risk scoring.

## System Architecture
1. **Engine:** `scripts/diffdelta_engine.py` (Modular, Source-Agnostic).
2. **Configuration:** `sources.config.json` (Defines URL, Type, and CSS Selectors).
3. **Storage:** Flat-file JSON structure in `/diff/{source_id}/latest.json`.
4. **State Management:** Local `_state.json` (not public) to track last-seen hashes.

## Mandatory Logic (The "Anti-Firehose" Guardrails)
- **Change Detection:** Compare new item hashes against `_state.json`. If no new hashes exist, set `changed: false` and EXIT.
- **Pre-Chew (Summary):** Every run MUST generate a `batch_narrative` (Max 30 words).
- **Risk Scoring:** Assign a `risk_score` (0.0 to 1.0) based on prompt-injection patterns or critical system changes.

## Constraints
- **Zero Database:** Use only GitHub Actions and flat JSON files.
- **Token Efficiency:** Summaries must be significantly smaller than the source data.
- **Validation:** Every output must pass `scripts/diffdelta_validate.py`.
