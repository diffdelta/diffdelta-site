# Decision Tree Bot Usability Analysis

## Current Structure

The decision tree is embedded in:
- `_protocol.decision_tree` in `head.json` files
- `.well-known/diffdelta.json` (discovery manifest)
- Documentation files (`openclaw/diffdelta_intelligence.md`, `docs/spec/client-quickstart.md`)

## Bot Usability Assessment

### ✅ **Strengths**

1. **Sequential numbering** - Steps are numbered (1, 2, 3, 4, 5, 6) making order clear
2. **Early exit conditions** - "SAME → STOP" is explicit
3. **Cost awareness** - Token/byte costs mentioned (~200 bytes, ~500 tokens)
4. **Field paths** - Exact JSON paths like `cursor`, `counts.flagged`, `alert_count`
5. **Actionable outcomes** - Each step says what to do (fetch, read, log, process)

### ⚠️ **Issues Identified**

1. **Per-source signal_coverage not in main flow**
   - Currently only mentioned in `trust_note` (separate from steps)
   - Bots need explicit step: "Check `sources[source_id].signal_coverage` when changed:true"
   - **Fix**: Added step `5b_check_source_coverage` in discovery manifest

2. **Trust note placement**
   - `trust_note` is separate from numbered steps
   - Bots might miss it or not know when to apply it
   - **Fix**: Integrated into step 4/5 flow

3. **Conditional logic not explicit**
   - Step 5b is conditional ("If you care about specific sources")
   - Bots need clearer: WHEN to check, WHAT to check, WHAT it means
   - **Fix**: Made it explicit: "If you care about specific sources, check..."

4. **Global vs per-source confusion**
   - Global `signal_coverage` in digest vs per-source in `sources` map
   - Bots might not understand the difference
   - **Fix**: Clarified in trust_note and step 5b

## Recommended Bot Flow

### Layer 1: Head Check (~200 bytes)
```
1. Fetch head.json
2. Compare cursor to stored cursor
   - SAME → STOP (nothing changed)
   - DIFFERENT → Continue
3. Read counts
   - flagged=0 AND new=0 → Low priority, MAY defer
   - flagged>0 OR new>0 → Continue to Layer 2
```

### Layer 2: Digest Check (~500 tokens)
```
4. Fetch digest.json
5. Read alert_count
   - alert_count=0 → Log narrative, STOP (no critical items)
   - alert_count>0 → Continue to Layer 3
6. Read signal_coverage (global aggregate)
   - Understand: Low values = many non-security sources, not failures
7. [OPTIONAL] If monitoring specific sources:
   - Fetch latest.json (or check sources map in digest if available)
   - Check sources[source_id].signal_coverage when changed:true
   - Security sources should have 100%, blogs/news may have 0%
```

### Layer 3: Full Feed (50-200 KB)
```
8. Fetch latest.json
9. Process buckets.flagged first (highest priority)
10. For each flagged item:
    - Read signals.suggested_action
    - Follow the action code (PATCH_IMMEDIATELY, VERSION_PIN, etc.)
    - Check signals.*.provenance for evidence chain
```

## Improvements Made

1. ✅ Added explicit step `5b_check_source_coverage` in discovery manifest
2. ✅ Updated `trust_note` to clarify global vs per-source coverage
3. ✅ Updated head.json decision trees to match
4. ✅ Documentation already explains per-source coverage in Layer 2

## Remaining Recommendations

1. **Consider adding to digest.json** - If digest.json includes a `sources` map (even minimal), bots could check per-source coverage without fetching latest.json
2. **Example code snippets** - Add concrete examples in decision tree comments:
   ```json
   "5b_example": "sources['cisa_kev'].signal_coverage === 100.0 → trust flagged:0 for this source"
   ```
3. **Source type hints** - Could add `source_type` field to help bots know what coverage to expect (security=100%, blog=0%)

## Conclusion

The decision tree is **mostly bot-friendly** but needed clarification on:
- When to check per-source coverage (added step 5b)
- Difference between global and per-source coverage (updated trust_note)
- Where to find per-source data (sources map in latest.json)

With these changes, bots can:
1. Follow the numbered steps sequentially
2. Understand when to check per-source coverage
3. Know what coverage values mean (100% for security, 0% for blogs is expected)
4. Make trust decisions at both global and per-source levels
