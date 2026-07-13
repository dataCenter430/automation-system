"""
Reference implementation of the v3 migration logic.

This module provides the canonical implementation of normalization formulas
and retirement criteria as specified in the mill handoff dossier. It is used
by the verifier to compute expected values independently of the agent's code.
"""

import hashlib
from datetime import datetime
from typing import Optional


# Correct constants from the dossier
RETIREMENT_AGE_DAYS = 45  # Section 9.3
RETIREMENT_QUALITY_THRESHOLD = 0.70  # Section 9.3
GRAYSCALE_COMPENSATION = 1.15  # Section 8.4
RGB_WEIGHT_R = 0.299  # Section 8.4 - BT.601
RGB_WEIGHT_G = 0.587  # Section 8.4 - BT.601
RGB_WEIGHT_B = 0.114  # Section 8.4 - BT.601


def compute_normalized_mean_grayscale(raw_mean: float) -> float:
    """
    Compute normalized mean for grayscale images.

    Formula from Section 8.4:
        normalized_mean = (raw_mean / 255.0) * 1.15

    The 1.15 factor compensates for loom lighting conditions.
    """
    return (raw_mean / 255.0) * GRAYSCALE_COMPENSATION


def compute_normalized_mean_rgb(r_mean: float, g_mean: float, b_mean: float) -> float:
    """
    Compute normalized mean for RGB images.

    Formula from Section 8.4:
        normalized_mean = 0.299 * (R/255) + 0.587 * (G/255) + 0.114 * (B/255)

    Uses BT.601 luminance weights. The 1.15 compensation factor is NOT applied
    to color images.
    """
    r_norm = r_mean / 255.0
    g_norm = g_mean / 255.0
    b_norm = b_mean / 255.0
    return RGB_WEIGHT_R * r_norm + RGB_WEIGHT_G * g_norm + RGB_WEIGHT_B * b_norm


def compute_normalized_mean_rgba(
    r_mean: float, g_mean: float, b_mean: float, a_mean: float
) -> float:
    """
    Compute normalized mean for RGBA images.

    Formula from Section 8.4:
        Same as RGB - alpha channel is IGNORED entirely.

    The alpha channel represents transparency, not luminance.
    """
    # Alpha is explicitly ignored per dossier Section 8.4
    _ = a_mean
    return compute_normalized_mean_rgb(r_mean, g_mean, b_mean)


def should_retire(
    capture_date: str,
    quality_score: float,
    defect_count: int,
    migration_date: str,
) -> bool:
    """
    Evaluate retirement eligibility.

    From Section 9.3 - ALL three criteria must be met simultaneously:
    1. capture_date is more than 45 days before migration_date
    2. quality_score < 0.70
    3. defect_count = 0 (or -1 sentinel)

    CRITICAL: Partial matches do NOT trigger retirement.
    """
    # Parse dates
    capture_dt = datetime.fromisoformat(capture_date.replace("Z", "+00:00"))
    migration_dt = datetime.fromisoformat(migration_date.replace("Z", "+00:00"))

    # Handle date-only strings
    if len(capture_date) == 10:
        capture_dt = datetime.strptime(capture_date, "%Y-%m-%d")
    if len(migration_date) == 10:
        migration_dt = datetime.strptime(migration_date, "%Y-%m-%d")

    # Calculate age in days
    age_days = (migration_dt - capture_dt).days

    # Evaluate criteria
    age_criterion = age_days > RETIREMENT_AGE_DAYS
    quality_criterion = quality_score < RETIREMENT_QUALITY_THRESHOLD
    defect_criterion = defect_count == 0 or defect_count == -1

    # ALL criteria must be met (AND logic, not OR)
    return age_criterion and quality_criterion and defect_criterion


def compute_provenance_hash(
    model_version: str,
    threshold_value: float,
    calibration_date: str,
) -> str:
    """
    Compute provenance hash.

    From Section 10.2:
        provenance = SHA256("{model_version}:{threshold_value:.2f}:{calibration_date}")
    """
    provenance_string = f"{model_version}:{threshold_value:.2f}:{calibration_date}"
    return hashlib.sha256(provenance_string.encode("utf-8")).hexdigest()


def quality_flag_to_score(quality_flag: int) -> Optional[float]:
    """
    Map legacy quality_flag to v3 quality_score.

    This is used when legacy records have integer flags instead of float scores.
    """
    if quality_flag <= 0:
        return None  # Should be retired
    elif quality_flag == 1:
        return 0.50
    elif quality_flag == 2:
        return 0.70
    elif quality_flag == 3:
        return 0.85
    elif quality_flag == 4:
        return 0.95
    else:
        return 1.00
