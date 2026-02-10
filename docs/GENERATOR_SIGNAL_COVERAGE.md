# Generator Fix: Per-Source Signal Coverage

## What Needs to Be Added

The generator needs to populate `signal_coverage` in the per-source status objects within the `sources` map.

## When to Include

Add `signal_coverage` to a source's status object when:
- `changed: true` AND
- The source has items in the current batch (any bucket: new, updated, removed, or flagged)

## Calculation Logic

```python
# For each source in the batch:
source_items = []
for bucket in ['new', 'updated', 'removed', 'flagged']:
    source_items.extend([item for item in feed['buckets'][bucket] 
                        if item['source'] == source_id])

total_items = len(source_items)
if total_items == 0:
    # No items → omit signal_coverage (zero bloat)
    continue

items_with_signals = len([item for item in source_items 
                          if item.get('signals') and len(item.get('signals', {})) > 0])

signal_coverage = (items_with_signals / total_items) * 100.0

# Add to source status (only when changed:true and has items)
if source_status['changed'] and total_items > 0:
    source_status['signal_coverage'] = round(signal_coverage, 1)  # One decimal place
```

## Example Output

```json
{
  "sources": {
    "cisa_kev": {
      "changed": true,
      "delta_counts": { "new": 0, "updated": 0, "removed": 0 },
      "signal_coverage": 100.0,  // ← Add this
      "status": "ok",
      ...
    },
    "nvidia_press_releases": {
      "changed": true,
      "delta_counts": { "new": 20, "updated": 0, "removed": 0 },
      "signal_coverage": 0.0,  // ← Add this (blog posts have no signals)
      "status": "ok",
      ...
    },
    "aws_whats_new": {
      "changed": false,
      // signal_coverage omitted (changed:false → zero bloat)
      ...
    }
  }
}
```

## Notes

- **Zero bloat**: Only include when `changed: true` and source has items
- **Precision**: Round to 1 decimal place (e.g., `100.0`, `0.0`, `87.5`)
- **Source-type dependent**: Security sources should have 100%, blogs/news should have 0% (expected, not a failure)
