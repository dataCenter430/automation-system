#!/usr/bin/env python3
"""
Initialize the legacy v2 feature store database with seeded data.
This script creates the legacy schema and populates it with records
that will be migrated to v3.
"""

import sqlite3
import random
import os
from datetime import datetime, timedelta

# Seed for reproducibility
random.seed(42)

DB_PATH = "/app/legacy/features.db"

# Legacy v2 schema
LEGACY_SCHEMA = """
CREATE TABLE IF NOT EXISTS features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_path TEXT NOT NULL,
    feature_vector BLOB NOT NULL,
    mean_value REAL,
    std_value REAL,
    model_version TEXT,
    quality_score REAL,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    channel_count INTEGER DEFAULT 1,
    defect_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS model_info (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_string TEXT NOT NULL,
    threshold_value REAL NOT NULL,
    calibration_date TEXT NOT NULL,
    deployed_date TEXT,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_features_image_path ON features(image_path);
CREATE INDEX IF NOT EXISTS idx_features_status ON features(status);
CREATE INDEX IF NOT EXISTS idx_features_model_version ON features(model_version);
"""

def generate_feature_vector(size=128):
    """Generate a random feature vector blob."""
    import struct
    values = [random.uniform(-1.0, 1.0) for _ in range(size)]
    return struct.pack(f'{size}f', *values)

def main():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    # Remove existing database
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Create schema
    cursor.executescript(LEGACY_SCHEMA)

    # Insert model info records
    models = [
        ("2.2.0", 0.72, "2023-11-15", "2023-12-01", "Initial production model"),
        ("2.3.1", 0.75, "2024-02-20", "2024-03-01", "Improved edge detection"),
        ("3.0.0", 0.78, "2024-08-10", "2024-09-01", "Current production model"),
    ]

    cursor.executemany(
        "INSERT INTO model_info (version_string, threshold_value, calibration_date, deployed_date, notes) VALUES (?, ?, ?, ?, ?)",
        models
    )

    # Generate feature records
    # We'll create records with various characteristics:
    # - Different ages (some > 45 days, some < 45 days)
    # - Different quality scores (some < 0.70, some >= 0.70)
    # - Different defect counts (0, or positive)
    # - Different channel counts (1 for grayscale, 3 for RGB, 4 for RGBA)

    base_date = datetime(2024, 11, 15)  # Migration date reference
    image_names = [
        "loom_001_frame_{:04d}.png",
        "loom_002_frame_{:04d}.png",
        "loom_003_frame_{:04d}.png",
    ]

    records = []
    feature_id = 1

    for loom_idx, image_template in enumerate(image_names):
        for frame_num in range(1, 51):  # 50 frames per loom = 150 total
            image_path = f"/app/images/{image_template.format(frame_num)}"

            # Vary the capture date
            days_ago = random.choice([10, 20, 30, 40, 50, 60, 70])
            capture_date = base_date - timedelta(days=days_ago)

            # Vary channel count
            channel_count = random.choice([1, 1, 1, 3, 3, 4])  # More grayscale

            # Generate mean values based on channel count
            if channel_count == 1:
                mean_value = random.uniform(80.0, 200.0)
            else:
                # For RGB/RGBA, store the combined raw mean
                r_mean = random.uniform(100.0, 180.0)
                g_mean = random.uniform(100.0, 180.0)
                b_mean = random.uniform(100.0, 180.0)
                # Legacy stores simple average (WRONG per dossier)
                mean_value = (r_mean + g_mean + b_mean) / 3.0

            std_value = random.uniform(15.0, 50.0)

            # Model version
            model_version = random.choice(["2.2.0", "2.3.1", "3.0.0"])

            # Quality score
            quality_score = random.uniform(0.50, 0.95)

            # Defect count (most have 0, some have defects)
            defect_count = random.choices([0, 0, 0, 1, 2, 3], weights=[60, 15, 10, 8, 5, 2])[0]

            # Feature vector
            feature_vector = generate_feature_vector()

            records.append((
                image_path,
                feature_vector,
                mean_value,
                std_value,
                model_version,
                quality_score,
                'active',
                capture_date.isoformat(),
                capture_date.isoformat(),
                channel_count,
                defect_count
            ))

            feature_id += 1

    cursor.executemany(
        """INSERT INTO features
           (image_path, feature_vector, mean_value, std_value, model_version,
            quality_score, status, created_at, updated_at, channel_count, defect_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        records
    )

    conn.commit()

    # Print summary
    cursor.execute("SELECT COUNT(*) FROM features")
    total = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM features WHERE channel_count = 1")
    grayscale = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM features WHERE channel_count = 3")
    rgb = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM features WHERE channel_count = 4")
    rgba = cursor.fetchone()[0]

    print(f"Created legacy database with {total} records")
    print(f"  Grayscale: {grayscale}")
    print(f"  RGB: {rgb}")
    print(f"  RGBA: {rgba}")

    conn.close()

if __name__ == "__main__":
    main()
