#!/usr/bin/env python3
"""
Generate sample loom frame images for the migration task.
Creates PNG images with known characteristics that can be
processed by ImageMagick for feature extraction.
"""

import os
import struct
import zlib
import random

random.seed(42)

IMAGE_DIR = "/app/images"

def create_png_grayscale(width, height, mean_value, std_value):
    """Create a grayscale PNG with specified statistics."""
    # Generate pixel data with approximately the target mean and std
    pixels = []
    for _ in range(height):
        row = []
        for _ in range(width):
            # Generate values around the mean with given std
            val = int(max(0, min(255, random.gauss(mean_value, std_value))))
            row.append(val)
        pixels.append(bytes(row))

    return create_png_bytes(width, height, 0, pixels)  # 0 = grayscale

def create_png_rgb(width, height, r_mean, g_mean, b_mean, std_value):
    """Create an RGB PNG with specified per-channel statistics."""
    pixels = []
    for _ in range(height):
        row = []
        for _ in range(width):
            r = int(max(0, min(255, random.gauss(r_mean, std_value))))
            g = int(max(0, min(255, random.gauss(g_mean, std_value))))
            b = int(max(0, min(255, random.gauss(b_mean, std_value))))
            row.extend([r, g, b])
        pixels.append(bytes(row))

    return create_png_bytes(width, height, 2, pixels)  # 2 = RGB

def create_png_rgba(width, height, r_mean, g_mean, b_mean, std_value):
    """Create an RGBA PNG with specified per-channel statistics."""
    pixels = []
    for _ in range(height):
        row = []
        for _ in range(width):
            r = int(max(0, min(255, random.gauss(r_mean, std_value))))
            g = int(max(0, min(255, random.gauss(g_mean, std_value))))
            b = int(max(0, min(255, random.gauss(b_mean, std_value))))
            a = 255  # Full opacity
            row.extend([r, g, b, a])
        pixels.append(bytes(row))

    return create_png_bytes(width, height, 6, pixels)  # 6 = RGBA

def create_png_bytes(width, height, color_type, pixel_rows):
    """Create PNG file bytes from raw pixel data."""
    def png_chunk(chunk_type, data):
        chunk = chunk_type + data
        crc = zlib.crc32(chunk) & 0xffffffff
        return struct.pack('>I', len(data)) + chunk + struct.pack('>I', crc)

    # PNG signature
    signature = b'\x89PNG\r\n\x1a\n'

    # IHDR chunk
    bit_depth = 8
    compression = 0
    filter_method = 0
    interlace = 0
    ihdr_data = struct.pack('>IIBBBBB', width, height, bit_depth, color_type,
                            compression, filter_method, interlace)
    ihdr = png_chunk(b'IHDR', ihdr_data)

    # IDAT chunk (compressed pixel data)
    raw_data = b''
    for row in pixel_rows:
        raw_data += b'\x00' + row  # Filter byte (0 = None) + row data

    compressed = zlib.compress(raw_data, 9)
    idat = png_chunk(b'IDAT', compressed)

    # IEND chunk
    iend = png_chunk(b'IEND', b'')

    return signature + ihdr + idat + iend

def main():
    os.makedirs(IMAGE_DIR, exist_ok=True)

    # Image dimensions
    width, height = 256, 256

    # Generate images for each loom
    for loom_num in range(1, 4):
        for frame_num in range(1, 51):
            filename = f"loom_{loom_num:03d}_frame_{frame_num:04d}.png"
            filepath = os.path.join(IMAGE_DIR, filename)

            # Determine image type based on pattern
            # Use seeded random to match the legacy database
            random.seed(42 + loom_num * 1000 + frame_num)
            channel_choice = random.choice([1, 1, 1, 3, 3, 4])

            # Generate with specific characteristics
            if channel_choice == 1:
                # Some grayscale images should have high mean values (>240)
                # so that with 1.15 factor, normalized_mean > 1.08
                # This allows tests to distinguish between 1.08 and 1.15 factors
                # For raw_mean > 240: 1.15 gives > 1.084, but 1.08 gives max 1.08
                if frame_num % 10 == 1:  # Every 10th grayscale gets high mean
                    mean_val = random.uniform(242.0, 250.0)
                else:
                    mean_val = random.uniform(80.0, 200.0)
                std_val = random.uniform(15.0, 50.0)
                png_bytes = create_png_grayscale(width, height, mean_val, std_val)
            elif channel_choice == 3:
                r_mean = random.uniform(100.0, 180.0)
                g_mean = random.uniform(100.0, 180.0)
                b_mean = random.uniform(100.0, 180.0)
                std_val = random.uniform(15.0, 50.0)
                png_bytes = create_png_rgb(width, height, r_mean, g_mean, b_mean, std_val)
            else:  # RGBA
                r_mean = random.uniform(100.0, 180.0)
                g_mean = random.uniform(100.0, 180.0)
                b_mean = random.uniform(100.0, 180.0)
                std_val = random.uniform(15.0, 50.0)
                png_bytes = create_png_rgba(width, height, r_mean, g_mean, b_mean, std_val)

            with open(filepath, 'wb') as f:
                f.write(png_bytes)

    print(f"Created 150 sample images in {IMAGE_DIR}")

if __name__ == "__main__":
    main()
