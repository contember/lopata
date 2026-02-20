#!/bin/bash

# Lopata - Automated Implementation Script
# Spouští Claude Code v loop, dokud nejsou všechny issues hotové

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "========================================"
echo "Lopata - Automated Implementation"
echo "========================================"
echo "Project: $PROJECT_DIR"
echo ""

PROMPT='Přečti si docs/INSTRUCTIONS.md a docs/STATUS.md. Najdi první pending issue, implementuj jej podle requirements, ověř že vše funguje (type-check, curl testy, persistence test) a aktualizuj STATUS.md. Pokud už nejsou žádné pending issues, odpověz pouze: <done>promise</done>'

ITERATION=1
MAX_ITERATIONS=50

while [ $ITERATION -le $MAX_ITERATIONS ]; do
    echo ""
    echo "========================================"
    echo "Iteration $ITERATION"
    echo "========================================"
    echo ""

    OUTPUT=$(claude --dangerously-skip-permissions -p "$PROMPT" 2>&1) || true

    echo "$OUTPUT"

    if echo "$OUTPUT" | grep -q "<done>promise</done>"; then
        echo ""
        echo "========================================"
        echo "All issues completed!"
        echo "========================================"
        exit 0
    fi

    if echo "$OUTPUT" | grep -qi "error\|failed\|fatal"; then
        echo ""
        echo "========================================"
        echo "Warning: Possible error detected"
        echo "Continuing to next iteration..."
        echo "========================================"
    fi

    ITERATION=$((ITERATION + 1))

    sleep 2
done

echo ""
echo "========================================"
echo "Max iterations ($MAX_ITERATIONS) reached"
echo "========================================"
exit 1
