#!/bin/bash
# Quick verification script for per-source feeds

echo "=== Checking for all per-source feed files ==="
find . -path "*diff/source/*/latest.json" -maxdepth 6 | sort

echo ""
echo "=== Expected sources ==="
echo "1. diff/source/moltbook/latest.json"
echo "2. diff/source/aws_whats_new/latest.json"
echo "3. diff/source/google_search_docs/latest.json"
echo "4. diff/source/pydantic_github/latest.json"
echo "5. diff/source/apple_developer_releases/latest.json"
echo "6. diff/source/nvidia_press_releases/latest.json"

echo ""
echo "=== Checking disabled source (aws_whats_new) ==="
if [ -f "diff/source/aws_whats_new/latest.json" ]; then
    echo "✓ File exists"
    echo "Status:"
    python3 -c "import json; d=json.load(open('diff/source/aws_whats_new/latest.json')); print('  status:', d['sources']['aws_whats_new']['status']); print('  changed:', d['changed']); print('  narrative:', d['batch_narrative'])"
else
    echo "✗ File missing!"
fi

echo ""
echo "=== Validating feeds ==="
python3 scripts/diffdelta_validate.py diff/latest.json 2>&1 | head -5
