#!/bin/bash

echo "🔍 Checking for unchecked arithmetic on i128 types..."

# Check for unchecked multiplication
if grep -r --include="*.rs" "[^a-zA-Z]\+[^*]\*[^=]" contracts/remittance/src/ | grep -v "checked_mul" | grep -v "saturating_mul" | grep -v "//"; then
    echo "❌ Found unchecked multiplication in remittance contract!"
    exit 1
fi

# Check for unchecked subtraction
if grep -r --include="*.rs" "[^a-zA-Z]\-[^*]\-[^=]" contracts/remittance/src/ | grep -v "checked_sub" | grep -v "saturating_sub" | grep -v "//"; then
    echo "❌ Found unchecked subtraction in remittance contract!"
    exit 1
fi

# Check for unchecked addition
if grep -r --include="*.rs" "[^a-zA-Z]\+[^*]\+=*[^=]" contracts/remittance/src/ | grep -v "checked_add" | grep -v "saturating_add" | grep -v "//"; then
    echo "❌ Found unchecked addition in remittance contract!"
    exit 1
fi

echo "✅ No unchecked arithmetic found."
exit 0
