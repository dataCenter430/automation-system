"""
Held-out test case generator for the textile migration verifier.

Generates fresh test cases that do not exist in the shipped fixtures.
These cases exercise the full input space including edge cases that
are likely to expose defects in the migration logic.
"""

import random
from dataclasses import dataclass
from typing import List


@dataclass
class HeldoutRecord:
    """A synthetic feature record for testing."""

    record_id: int
    channel_count: int  # 1, 3, or 4
    raw_mean: float  # For grayscale
    r_mean: float  # For RGB/RGBA
    g_mean: float
    b_mean: float
    quality_score: float
    defect_count: int
    days_ago: int  # Days before migration date


def generate_heldout_records(seed: int = 12345, count: int = 100) -> List[HeldoutRecord]:
    """
    Generate deterministic held-out test records.

    These records are designed to exercise edge cases:
    - Boundary values for retirement criteria (44, 45, 46 days)
    - Boundary values for quality threshold (0.69, 0.70, 0.71)
    - Various defect counts (0, 1, -1)
    - Different channel counts (grayscale, RGB, RGBA)
    - Extreme mean values (near 0, near 255)
    """
    random.seed(seed)
    records = []

    for i in range(count):
        # Vary channel count
        channel_count = random.choice([1, 1, 1, 3, 3, 4])

        # Generate mean values
        if channel_count == 1:
            raw_mean = random.uniform(10.0, 245.0)
            r_mean = g_mean = b_mean = 0.0
        else:
            raw_mean = 0.0
            r_mean = random.uniform(50.0, 220.0)
            g_mean = random.uniform(50.0, 220.0)
            b_mean = random.uniform(50.0, 220.0)

        # Quality score - include boundary cases
        if i % 10 == 0:
            # Exact boundary cases
            quality_score = random.choice([0.69, 0.70, 0.71])
        else:
            quality_score = random.uniform(0.50, 0.95)

        # Defect count - include various patterns
        if i % 5 == 0:
            defect_count = 0  # No defects
        elif i % 7 == 0:
            defect_count = -1  # Sentinel value
        else:
            defect_count = random.choice([0, 0, 1, 2, 3])

        # Age in days - include boundary cases
        if i % 8 == 0:
            # Exact boundary cases (45 days threshold)
            days_ago = random.choice([44, 45, 46])
        else:
            days_ago = random.randint(10, 80)

        records.append(
            HeldoutRecord(
                record_id=i + 1000,  # Offset to avoid collision with fixture IDs
                channel_count=channel_count,
                raw_mean=raw_mean,
                r_mean=r_mean,
                g_mean=g_mean,
                b_mean=b_mean,
                quality_score=quality_score,
                defect_count=defect_count,
                days_ago=days_ago,
            )
        )

    return records


def generate_edge_cases() -> List[HeldoutRecord]:
    """
    Generate specific edge cases that target known defect patterns.

    These cases are designed to catch:
    1. Wrong grayscale compensation factor (1.08 vs 1.15)
    2. Wrong RGB weights (equal vs BT.601)
    3. Wrong retirement age threshold (30 vs 45 days)
    4. Wrong quality threshold (0.65 vs 0.70)
    5. Wrong retirement logic (OR vs AND)
    """
    cases = []
    base_id = 2000

    # Case 1: Grayscale with mean that shows difference between 1.08 and 1.15
    # raw_mean = 200 -> 1.08 gives 0.8471, 1.15 gives 0.9020
    cases.append(
        HeldoutRecord(
            record_id=base_id,
            channel_count=1,
            raw_mean=200.0,
            r_mean=0.0,
            g_mean=0.0,
            b_mean=0.0,
            quality_score=0.80,
            defect_count=0,
            days_ago=20,
        )
    )

    # Case 2: RGB that shows difference between equal weights and BT.601
    # R=255, G=0, B=0: equal gives 0.333, BT.601 gives 0.299
    cases.append(
        HeldoutRecord(
            record_id=base_id + 1,
            channel_count=3,
            raw_mean=0.0,
            r_mean=255.0,
            g_mean=0.0,
            b_mean=0.0,
            quality_score=0.80,
            defect_count=0,
            days_ago=20,
        )
    )

    # Case 3: RGB with G dominant - shows BT.601 weight difference
    # R=0, G=255, B=0: equal gives 0.333, BT.601 gives 0.587
    cases.append(
        HeldoutRecord(
            record_id=base_id + 2,
            channel_count=3,
            raw_mean=0.0,
            r_mean=0.0,
            g_mean=255.0,
            b_mean=0.0,
            quality_score=0.80,
            defect_count=0,
            days_ago=20,
        )
    )

    # Case 4: Record at 35 days (between 30 and 45)
    # Should NOT retire with correct 45-day threshold
    # WOULD retire with wrong 30-day threshold
    cases.append(
        HeldoutRecord(
            record_id=base_id + 3,
            channel_count=1,
            raw_mean=128.0,
            r_mean=0.0,
            g_mean=0.0,
            b_mean=0.0,
            quality_score=0.60,  # Below 0.70
            defect_count=0,  # Zero defects
            days_ago=35,  # Between 30 and 45
        )
    )

    # Case 5: Record with quality 0.67 (between 0.65 and 0.70)
    # Should NOT meet quality criterion with correct 0.70 threshold
    # WOULD meet criterion with wrong 0.65 threshold
    cases.append(
        HeldoutRecord(
            record_id=base_id + 4,
            channel_count=1,
            raw_mean=128.0,
            r_mean=0.0,
            g_mean=0.0,
            b_mean=0.0,
            quality_score=0.67,  # Between 0.65 and 0.70
            defect_count=0,
            days_ago=50,  # Old enough
        )
    )

    # Case 6: Record that meets ONE criterion (age) but not others
    # Should NOT retire with correct AND logic
    # WOULD retire with wrong OR logic
    cases.append(
        HeldoutRecord(
            record_id=base_id + 5,
            channel_count=1,
            raw_mean=128.0,
            r_mean=0.0,
            g_mean=0.0,
            b_mean=0.0,
            quality_score=0.85,  # Above 0.70 (does NOT meet criterion)
            defect_count=0,
            days_ago=60,  # Meets age criterion
        )
    )

    # Case 7: Record that meets quality criterion only
    # Should NOT retire with correct AND logic
    # WOULD retire with wrong OR logic
    cases.append(
        HeldoutRecord(
            record_id=base_id + 6,
            channel_count=1,
            raw_mean=128.0,
            r_mean=0.0,
            g_mean=0.0,
            b_mean=0.0,
            quality_score=0.50,  # Meets quality criterion
            defect_count=2,  # Does NOT meet defect criterion
            days_ago=20,  # Does NOT meet age criterion
        )
    )

    # Case 8: Record that meets ALL criteria (should retire)
    cases.append(
        HeldoutRecord(
            record_id=base_id + 7,
            channel_count=1,
            raw_mean=128.0,
            r_mean=0.0,
            g_mean=0.0,
            b_mean=0.0,
            quality_score=0.50,  # Meets quality criterion
            defect_count=0,  # Meets defect criterion
            days_ago=60,  # Meets age criterion
        )
    )

    # Case 9: RGBA - verify alpha is ignored
    cases.append(
        HeldoutRecord(
            record_id=base_id + 8,
            channel_count=4,
            raw_mean=0.0,
            r_mean=128.0,
            g_mean=128.0,
            b_mean=128.0,
            quality_score=0.80,
            defect_count=0,
            days_ago=20,
        )
    )

    return cases
