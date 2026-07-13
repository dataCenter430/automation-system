#!/bin/bash
set -euo pipefail

# Oracle solution for textile feature store migration
#
# This script fixes the five defects in /app/src/migrate.cpp:
#
# DEFECT #1: RETIREMENT_AGE_DAYS = 30 (should be 45)
#            The dossier Section 9.3 specifies 45 days, but the code uses
#            the superseded 30-day value from Section 6.2.
#
# DEFECT #2: RETIREMENT_QUALITY_THRESHOLD = 0.65 (should be 0.70)
#            The dossier Section 9.3 specifies 0.70, but the code uses
#            the superseded 0.65 value from Section 6.2.
#
# DEFECT #3: GRAYSCALE_COMPENSATION = 1.08 (should be 1.15)
#            The dossier Section 8.4 specifies 1.15, but the code uses
#            the superseded 1.08 value from Section 6.1.
#
# DEFECT #4: RGB weights are equal (0.333/0.333/0.334) instead of BT.601
#            The dossier Section 8.4 specifies 0.299/0.587/0.114.
#
# DEFECT #5: Retirement uses OR logic instead of AND logic
#            The dossier Section 9.3 explicitly states ALL criteria must
#            be met simultaneously, but the code uses the superseded OR
#            logic from Section 6.2.

cd /app

# Fix defect #1: Change retirement age from 30 to 45 days
sed -i 's/RETIREMENT_AGE_DAYS = 30/RETIREMENT_AGE_DAYS = 45/' src/migrate.cpp

# Fix defect #2: Change quality threshold from 0.65 to 0.70
sed -i 's/RETIREMENT_QUALITY_THRESHOLD = 0.65/RETIREMENT_QUALITY_THRESHOLD = 0.70/' src/migrate.cpp

# Fix defect #3: Change grayscale compensation from 1.08 to 1.15
sed -i 's/GRAYSCALE_COMPENSATION = 1.08/GRAYSCALE_COMPENSATION = 1.15/' src/migrate.cpp

# Fix defect #4: Change RGB weights from equal to BT.601
sed -i 's/RGB_WEIGHT_R = 0.333/RGB_WEIGHT_R = 0.299/' src/migrate.cpp
sed -i 's/RGB_WEIGHT_G = 0.333/RGB_WEIGHT_G = 0.587/' src/migrate.cpp
sed -i 's/RGB_WEIGHT_B = 0.334/RGB_WEIGHT_B = 0.114/' src/migrate.cpp

# Fix defect #5: Change retirement logic from OR to AND
# The buggy line is: return age_criterion || quality_criterion;
# The correct line is: return age_criterion && quality_criterion && defect_criterion;
sed -i 's/return age_criterion || quality_criterion;/return age_criterion \&\& quality_criterion \&\& defect_criterion;/' src/migrate.cpp

# Rebuild the migration tool
make clean
make

# Run the migration with deterministic timestamp
export MIGRATION_TIMESTAMP="2024-11-15T00:00:00Z"
./bin/migrate \
    --legacy /app/legacy/features.db \
    --output /app/output/features_v3.db \
    --images /app/images \
    --batch "MIGRATION-20241115"

echo "Migration complete. Output files in /app/output/"
ls -la /app/output/
