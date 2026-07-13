/*
 * Textile Feature Store Migration Tool
 * Migrates legacy v2 schema to v3 schema
 *
 * Usage: ./migrate --legacy <path> --output <path> --images <path> [--batch <name>]
 */

#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <iomanip>
#include <sqlite3.h>
#include <openssl/sha.h>
#include <openssl/md5.h>
#include <sys/stat.h>
#include <algorithm>

// Configuration
static std::string legacy_db_path;
static std::string output_db_path;
static std::string images_path;
static std::string batch_name = "BATCH-001";
static std::string migration_timestamp;

// Constants
// DEFECT #1: Using WRONG retirement threshold (30 days instead of 45 days)
// The dossier specifies 45 days in Section 9.3, but this uses the
// SUPERSEDED value from Section 6.2
static const int RETIREMENT_AGE_DAYS = 30;

// DEFECT #2: Using WRONG quality threshold (0.65 instead of 0.70)
// The dossier specifies 0.70 in Section 9.3, but this uses the
// SUPERSEDED value from Section 6.2
static const double RETIREMENT_QUALITY_THRESHOLD = 0.65;

// Normalization constants
// DEFECT #3: Using WRONG grayscale factor (1.08 instead of 1.15)
// The dossier specifies 1.15 in Section 8.4, but this uses the
// SUPERSEDED value from Section 6.1
static const double GRAYSCALE_COMPENSATION = 1.08;

// DEFECT #4: Using WRONG RGB weights (equal 0.333 instead of BT.601)
// The dossier specifies 0.299/0.587/0.114 in Section 8.4, but this uses
// SUPERSEDED equal weighting from Section 6.1
static const double RGB_WEIGHT_R = 0.333;
static const double RGB_WEIGHT_G = 0.333;
static const double RGB_WEIGHT_B = 0.334;

// DEFECT #5: Using OR logic for retirement (ANY criterion) instead of AND (ALL criteria)
// The dossier explicitly states in Section 9.3 that ALL criteria must be met,
// but this implements the SUPERSEDED OR logic from Section 6.2

struct LegacyRecord {
    int id;
    std::string image_path;
    std::vector<unsigned char> feature_vector;
    double mean_value;
    double std_value;
    std::string model_version;
    double quality_score;
    std::string status;
    std::string created_at;
    int channel_count;
    int defect_count;
};

struct ModelInfo {
    int id;
    std::string version_string;
    double threshold_value;
    std::string calibration_date;
};

// Utility functions
std::string sha256_hash(const std::string& input) {
    unsigned char hash[SHA256_DIGEST_LENGTH];
    SHA256((unsigned char*)input.c_str(), input.length(), hash);

    std::stringstream ss;
    for (int i = 0; i < SHA256_DIGEST_LENGTH; i++) {
        ss << std::hex << std::setfill('0') << std::setw(2) << (int)hash[i];
    }
    return ss.str();
}

std::string md5_hash_file(const std::string& filepath) {
    std::ifstream file(filepath, std::ios::binary);
    if (!file) return "";

    MD5_CTX ctx;
    MD5_Init(&ctx);

    char buffer[8192];
    while (file.read(buffer, sizeof(buffer))) {
        MD5_Update(&ctx, buffer, file.gcount());
    }
    MD5_Update(&ctx, buffer, file.gcount());

    unsigned char hash[MD5_DIGEST_LENGTH];
    MD5_Final(hash, &ctx);

    std::stringstream ss;
    for (int i = 0; i < MD5_DIGEST_LENGTH; i++) {
        ss << std::hex << std::setfill('0') << std::setw(2) << (int)hash[i];
    }
    return ss.str();
}

bool file_exists(const std::string& path) {
    struct stat buffer;
    return (stat(path.c_str(), &buffer) == 0);
}

int days_between(const std::string& date1, const std::string& date2) {
    // Simple date difference calculation
    // Assumes ISO format YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
    struct tm tm1 = {}, tm2 = {};

    std::string d1 = date1.substr(0, 10);
    std::string d2 = date2.substr(0, 10);

    strptime(d1.c_str(), "%Y-%m-%d", &tm1);
    strptime(d2.c_str(), "%Y-%m-%d", &tm2);

    time_t t1 = mktime(&tm1);
    time_t t2 = mktime(&tm2);

    return (int)difftime(t2, t1) / (60 * 60 * 24);
}

std::string get_migration_timestamp() {
    // Check for environment override for determinism
    const char* env_ts = std::getenv("MIGRATION_TIMESTAMP");
    if (env_ts) {
        return std::string(env_ts);
    }

    time_t now = time(nullptr);
    struct tm* tm_info = gmtime(&now);
    char buffer[32];
    strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", tm_info);
    return std::string(buffer);
}

std::string get_migration_date() {
    return migration_timestamp.substr(0, 10);
}

// ImageMagick integration
struct ImageStats {
    double mean;
    double std_dev;
    int channels;
    double r_mean, g_mean, b_mean;
};

ImageStats get_image_stats(const std::string& image_path) {
    ImageStats stats = {0, 0, 1, 0, 0, 0};

    // Get channel count first
    std::string cmd_channels = "identify -format '%[channels]' '" + image_path + "' 2>/dev/null";
    FILE* pipe = popen(cmd_channels.c_str(), "r");
    if (pipe) {
        char buffer[128];
        if (fgets(buffer, sizeof(buffer), pipe)) {
            std::string channels_str(buffer);
            if (channels_str.find("srgba") != std::string::npos ||
                channels_str.find("rgba") != std::string::npos) {
                stats.channels = 4;
            } else if (channels_str.find("srgb") != std::string::npos ||
                       channels_str.find("rgb") != std::string::npos) {
                stats.channels = 3;
            } else {
                stats.channels = 1;
            }
        }
        pclose(pipe);
    }

    // Get statistics
    std::string cmd_stats = "identify -verbose '" + image_path + "' 2>/dev/null | grep -E '(mean|standard deviation):' | head -8";
    pipe = popen(cmd_stats.c_str(), "r");
    if (pipe) {
        char buffer[256];
        std::vector<double> means, stds;

        while (fgets(buffer, sizeof(buffer), pipe)) {
            std::string line(buffer);
            size_t pos = line.find(':');
            if (pos != std::string::npos) {
                std::string value_part = line.substr(pos + 1);
                // Extract the numeric value (may have " (0.xxx)" format)
                size_t paren = value_part.find('(');
                if (paren != std::string::npos) {
                    value_part = value_part.substr(0, paren);
                }
                double value = std::stod(value_part);

                if (line.find("mean") != std::string::npos) {
                    means.push_back(value);
                } else if (line.find("standard deviation") != std::string::npos) {
                    stds.push_back(value);
                }
            }
        }
        pclose(pipe);

        if (!means.empty()) {
            if (stats.channels == 1 && means.size() >= 1) {
                stats.mean = means[0];
                stats.std_dev = stds.empty() ? 0 : stds[0];
            } else if (stats.channels >= 3 && means.size() >= 3) {
                stats.r_mean = means[0];
                stats.g_mean = means[1];
                stats.b_mean = means[2];
                stats.std_dev = stds.empty() ? 0 : (stds[0] + stds[1] + stds[2]) / 3.0;
            }
        }
    }

    return stats;
}

double compute_normalized_mean(const ImageStats& stats) {
    if (stats.channels == 1) {
        // Grayscale: (raw/255) * compensation_factor
        // DEFECT #3: Using 1.08 instead of 1.15
        return (stats.mean / 255.0) * GRAYSCALE_COMPENSATION;
    } else {
        // RGB/RGBA: weighted average
        // DEFECT #4: Using equal weights instead of BT.601
        double r_norm = stats.r_mean / 255.0;
        double g_norm = stats.g_mean / 255.0;
        double b_norm = stats.b_mean / 255.0;
        return RGB_WEIGHT_R * r_norm + RGB_WEIGHT_G * g_norm + RGB_WEIGHT_B * b_norm;
    }
}

bool should_retire(const LegacyRecord& record) {
    std::string migration_date = get_migration_date();
    int age_days = days_between(record.created_at, migration_date);

    bool age_criterion = age_days > RETIREMENT_AGE_DAYS;
    bool quality_criterion = record.quality_score < RETIREMENT_QUALITY_THRESHOLD;
    bool defect_criterion = (record.defect_count == 0 || record.defect_count == -1);

    // DEFECT #5: Using OR logic instead of AND logic
    // Dossier Section 9.3 states: "ALL three conditions must be met simultaneously"
    // But this implements the SUPERSEDED Version 2.x OR logic from Section 6.2
    return age_criterion || quality_criterion;  // WRONG: should be age_criterion && quality_criterion && defect_criterion
}

std::string compute_provenance_hash(const std::string& model_version,
                                     double threshold_value,
                                     const std::string& calibration_date) {
    std::stringstream ss;
    ss << model_version << ":" << std::fixed << std::setprecision(2) << threshold_value << ":" << calibration_date;
    return sha256_hash(ss.str());
}

// Database operations
int create_v3_schema(sqlite3* db) {
    const char* schema = R"(
        CREATE TABLE IF NOT EXISTS features_v3 (
            feature_id INTEGER PRIMARY KEY,
            image_path TEXT NOT NULL,
            normalized_mean REAL NOT NULL,
            channel_count INTEGER NOT NULL,
            quality_score REAL,
            defect_count INTEGER DEFAULT 0,
            capture_date TEXT NOT NULL,
            retired INTEGER DEFAULT 0,
            threshold_provenance TEXT,
            model_id INTEGER,
            feature_vector BLOB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS model_metadata (
            model_id INTEGER PRIMARY KEY,
            model_version TEXT NOT NULL,
            threshold_value REAL NOT NULL,
            calibration_date TEXT NOT NULL,
            deployment_date TEXT,
            description TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS migration_audit (
            audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id INTEGER NOT NULL,
            action TEXT NOT NULL,
            reason TEXT,
            migration_ts TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_features_v3_capture_date ON features_v3(capture_date);
        CREATE INDEX IF NOT EXISTS idx_features_v3_retired ON features_v3(retired);
        CREATE INDEX IF NOT EXISTS idx_features_v3_model_id ON features_v3(model_id);
        CREATE INDEX IF NOT EXISTS idx_features_v3_image_path ON features_v3(image_path);
        CREATE INDEX IF NOT EXISTS idx_features_v3_retirement_criteria
            ON features_v3(capture_date, quality_score, defect_count, retired);
    )";

    char* err_msg = nullptr;
    int rc = sqlite3_exec(db, schema, nullptr, nullptr, &err_msg);
    if (rc != SQLITE_OK) {
        std::cerr << "Schema creation error: " << err_msg << std::endl;
        sqlite3_free(err_msg);
        return rc;
    }
    return SQLITE_OK;
}

std::vector<LegacyRecord> load_legacy_records(sqlite3* db) {
    std::vector<LegacyRecord> records;

    const char* sql = R"(
        SELECT id, image_path, feature_vector, mean_value, std_value,
               model_version, quality_score, status, created_at,
               channel_count, defect_count
        FROM features
        ORDER BY id
    )";

    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) == SQLITE_OK) {
        while (sqlite3_step(stmt) == SQLITE_ROW) {
            LegacyRecord rec;
            rec.id = sqlite3_column_int(stmt, 0);
            rec.image_path = (const char*)sqlite3_column_text(stmt, 1);

            const void* blob = sqlite3_column_blob(stmt, 2);
            int blob_size = sqlite3_column_bytes(stmt, 2);
            rec.feature_vector.assign((unsigned char*)blob, (unsigned char*)blob + blob_size);

            rec.mean_value = sqlite3_column_double(stmt, 3);
            rec.std_value = sqlite3_column_double(stmt, 4);
            rec.model_version = (const char*)sqlite3_column_text(stmt, 5);
            rec.quality_score = sqlite3_column_double(stmt, 6);
            rec.status = (const char*)sqlite3_column_text(stmt, 7);
            rec.created_at = (const char*)sqlite3_column_text(stmt, 8);
            rec.channel_count = sqlite3_column_int(stmt, 9);
            rec.defect_count = sqlite3_column_int(stmt, 10);

            records.push_back(rec);
        }
        sqlite3_finalize(stmt);
    }

    return records;
}

std::vector<ModelInfo> load_model_info(sqlite3* db) {
    std::vector<ModelInfo> models;

    const char* sql = "SELECT id, version_string, threshold_value, calibration_date FROM model_info ORDER BY id";

    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) == SQLITE_OK) {
        while (sqlite3_step(stmt) == SQLITE_ROW) {
            ModelInfo m;
            m.id = sqlite3_column_int(stmt, 0);
            m.version_string = (const char*)sqlite3_column_text(stmt, 1);
            m.threshold_value = sqlite3_column_double(stmt, 2);
            m.calibration_date = (const char*)sqlite3_column_text(stmt, 3);
            models.push_back(m);
        }
        sqlite3_finalize(stmt);
    }

    return models;
}

int find_model_id(const std::vector<ModelInfo>& models, const std::string& version) {
    for (const auto& m : models) {
        if (m.version_string == version) {
            return m.id;
        }
    }
    return -1;
}

void write_checksums(sqlite3* db, const std::string& db_path, const std::string& output_dir) {
    // Compute database MD5
    std::string db_md5 = md5_hash_file(db_path);

    // Compute feature vector SHA256
    SHA256_CTX sha_ctx;
    SHA256_Init(&sha_ctx);

    const char* sql = "SELECT feature_vector FROM features_v3 ORDER BY feature_id ASC";
    sqlite3_stmt* stmt;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) == SQLITE_OK) {
        while (sqlite3_step(stmt) == SQLITE_ROW) {
            const void* blob = sqlite3_column_blob(stmt, 0);
            int blob_size = sqlite3_column_bytes(stmt, 0);
            SHA256_Update(&sha_ctx, blob, blob_size);
        }
        sqlite3_finalize(stmt);
    }

    unsigned char sha_hash[SHA256_DIGEST_LENGTH];
    SHA256_Final(sha_hash, &sha_ctx);

    std::stringstream sha_ss;
    for (int i = 0; i < SHA256_DIGEST_LENGTH; i++) {
        sha_ss << std::hex << std::setfill('0') << std::setw(2) << (int)sha_hash[i];
    }
    std::string vector_sha256 = sha_ss.str();

    // Write checksum file
    std::string checksum_path = output_dir + "/checksum.txt";
    std::ofstream checksum_file(checksum_path);
    checksum_file << db_md5 << "\n";
    checksum_file << vector_sha256 << "\n";
    checksum_file.close();

    std::cout << "Wrote checksums to " << checksum_path << std::endl;
}

void write_summary(sqlite3* db, const std::string& output_dir,
                   int total_source, int migrated, int retired, int skipped,
                   int threshold_count, int active_thresholds) {
    std::string summary_path = output_dir + "/migration_summary.json";
    std::ofstream summary_file(summary_path);

    summary_file << "{\n";
    summary_file << "    \"total_source_records\": " << total_source << ",\n";
    summary_file << "    \"migrated_count\": " << migrated << ",\n";
    summary_file << "    \"retired_count\": " << retired << ",\n";
    summary_file << "    \"skipped_count\": " << skipped << ",\n";
    summary_file << "    \"threshold_count\": " << threshold_count << ",\n";
    summary_file << "    \"active_threshold_count\": " << active_thresholds << ",\n";
    summary_file << "    \"migration_timestamp\": \"" << migration_timestamp << "\",\n";
    summary_file << "    \"schema_version\": \"3.0\"\n";
    summary_file << "}\n";

    summary_file.close();
    std::cout << "Wrote summary to " << summary_path << std::endl;
}

int run_migration() {
    migration_timestamp = get_migration_timestamp();
    std::cout << "Starting migration at " << migration_timestamp << std::endl;

    // Open legacy database
    sqlite3* legacy_db;
    if (sqlite3_open(legacy_db_path.c_str(), &legacy_db) != SQLITE_OK) {
        std::cerr << "Cannot open legacy database: " << legacy_db_path << std::endl;
        return 2;
    }

    // Create output database
    sqlite3* output_db;
    if (sqlite3_open(output_db_path.c_str(), &output_db) != SQLITE_OK) {
        std::cerr << "Cannot create output database: " << output_db_path << std::endl;
        sqlite3_close(legacy_db);
        return 3;
    }

    // Create v3 schema
    if (create_v3_schema(output_db) != SQLITE_OK) {
        sqlite3_close(legacy_db);
        sqlite3_close(output_db);
        return 5;
    }

    // Load data
    std::vector<LegacyRecord> records = load_legacy_records(legacy_db);
    std::vector<ModelInfo> models = load_model_info(legacy_db);

    std::cout << "Loaded " << records.size() << " legacy records" << std::endl;
    std::cout << "Loaded " << models.size() << " model info records" << std::endl;

    // Migrate model metadata
    const char* insert_model = R"(
        INSERT INTO model_metadata (model_id, model_version, threshold_value, calibration_date)
        VALUES (?, ?, ?, ?)
    )";
    sqlite3_stmt* model_stmt;
    sqlite3_prepare_v2(output_db, insert_model, -1, &model_stmt, nullptr);

    for (const auto& m : models) {
        sqlite3_bind_int(model_stmt, 1, m.id);
        sqlite3_bind_text(model_stmt, 2, m.version_string.c_str(), -1, SQLITE_STATIC);
        sqlite3_bind_double(model_stmt, 3, m.threshold_value);
        sqlite3_bind_text(model_stmt, 4, m.calibration_date.c_str(), -1, SQLITE_STATIC);
        sqlite3_step(model_stmt);
        sqlite3_reset(model_stmt);
    }
    sqlite3_finalize(model_stmt);

    // Migrate features
    const char* insert_feature = R"(
        INSERT INTO features_v3 (feature_id, image_path, normalized_mean, channel_count,
                                  quality_score, defect_count, capture_date, retired,
                                  threshold_provenance, model_id, feature_vector)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    )";
    sqlite3_stmt* feature_stmt;
    sqlite3_prepare_v2(output_db, insert_feature, -1, &feature_stmt, nullptr);

    const char* insert_audit = R"(
        INSERT INTO migration_audit (source_id, action, reason, migration_ts)
        VALUES (?, ?, ?, ?)
    )";
    sqlite3_stmt* audit_stmt;
    sqlite3_prepare_v2(output_db, insert_audit, -1, &audit_stmt, nullptr);

    int migrated = 0, retired_count = 0, skipped = 0;

    sqlite3_exec(output_db, "BEGIN TRANSACTION", nullptr, nullptr, nullptr);

    for (const auto& rec : records) {
        // Check if image exists
        std::string full_image_path = rec.image_path;
        if (rec.image_path[0] != '/') {
            full_image_path = images_path + "/" + rec.image_path;
        }

        if (!file_exists(full_image_path)) {
            // Log as skipped
            sqlite3_bind_int(audit_stmt, 1, rec.id);
            sqlite3_bind_text(audit_stmt, 2, "skipped", -1, SQLITE_STATIC);
            sqlite3_bind_text(audit_stmt, 3, "missing_image", -1, SQLITE_STATIC);
            sqlite3_bind_text(audit_stmt, 4, migration_timestamp.c_str(), -1, SQLITE_STATIC);
            sqlite3_step(audit_stmt);
            sqlite3_reset(audit_stmt);
            skipped++;
            continue;
        }

        // Get image stats from ImageMagick
        ImageStats stats = get_image_stats(full_image_path);
        if (stats.channels == 0) {
            stats.channels = rec.channel_count;  // Fallback to legacy value
        }

        // Compute normalized mean
        double normalized_mean = compute_normalized_mean(stats);

        // Check retirement
        bool should_retire_rec = should_retire(rec);

        // Find model and compute provenance
        int model_id = find_model_id(models, rec.model_version);
        std::string provenance;
        if (model_id > 0) {
            for (const auto& m : models) {
                if (m.id == model_id) {
                    provenance = compute_provenance_hash(m.version_string, m.threshold_value, m.calibration_date);
                    break;
                }
            }
        }

        // Insert feature record
        sqlite3_bind_int(feature_stmt, 1, rec.id);
        sqlite3_bind_text(feature_stmt, 2, rec.image_path.c_str(), -1, SQLITE_STATIC);
        sqlite3_bind_double(feature_stmt, 3, normalized_mean);
        sqlite3_bind_int(feature_stmt, 4, stats.channels);
        sqlite3_bind_double(feature_stmt, 5, rec.quality_score);
        sqlite3_bind_int(feature_stmt, 6, rec.defect_count);
        sqlite3_bind_text(feature_stmt, 7, rec.created_at.substr(0, 10).c_str(), -1, SQLITE_STATIC);
        sqlite3_bind_int(feature_stmt, 8, should_retire_rec ? 1 : 0);
        if (!provenance.empty()) {
            sqlite3_bind_text(feature_stmt, 9, provenance.c_str(), -1, SQLITE_STATIC);
        } else {
            sqlite3_bind_null(feature_stmt, 9);
        }
        sqlite3_bind_int(feature_stmt, 10, model_id);
        sqlite3_bind_blob(feature_stmt, 11, rec.feature_vector.data(), rec.feature_vector.size(), SQLITE_STATIC);

        sqlite3_step(feature_stmt);
        sqlite3_reset(feature_stmt);

        // Log audit
        const char* action = should_retire_rec ? "retired" : "migrated";
        const char* reason = should_retire_rec ? "retirement_criteria" : nullptr;

        sqlite3_bind_int(audit_stmt, 1, rec.id);
        sqlite3_bind_text(audit_stmt, 2, action, -1, SQLITE_STATIC);
        if (reason) {
            sqlite3_bind_text(audit_stmt, 3, reason, -1, SQLITE_STATIC);
        } else {
            sqlite3_bind_null(audit_stmt, 3);
        }
        sqlite3_bind_text(audit_stmt, 4, migration_timestamp.c_str(), -1, SQLITE_STATIC);
        sqlite3_step(audit_stmt);
        sqlite3_reset(audit_stmt);

        if (should_retire_rec) {
            retired_count++;
        } else {
            migrated++;
        }
    }

    sqlite3_exec(output_db, "COMMIT", nullptr, nullptr, nullptr);

    sqlite3_finalize(feature_stmt);
    sqlite3_finalize(audit_stmt);

    std::cout << "Migration complete:" << std::endl;
    std::cout << "  Migrated: " << migrated << std::endl;
    std::cout << "  Retired: " << retired_count << std::endl;
    std::cout << "  Skipped: " << skipped << std::endl;

    // Write checksums and summary
    std::string output_dir = output_db_path.substr(0, output_db_path.rfind('/'));
    write_checksums(output_db, output_db_path, output_dir);
    write_summary(output_db, output_dir, records.size(), migrated, retired_count, skipped,
                  models.size(), models.size());

    sqlite3_close(legacy_db);
    sqlite3_close(output_db);

    return 0;
}

void print_usage(const char* program) {
    std::cerr << "Usage: " << program << " --legacy <path> --output <path> --images <path> [--batch <name>]" << std::endl;
}

int main(int argc, char* argv[]) {
    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--legacy" && i + 1 < argc) {
            legacy_db_path = argv[++i];
        } else if (arg == "--output" && i + 1 < argc) {
            output_db_path = argv[++i];
        } else if (arg == "--images" && i + 1 < argc) {
            images_path = argv[++i];
        } else if (arg == "--batch" && i + 1 < argc) {
            batch_name = argv[++i];
        } else if (arg == "--help" || arg == "-h") {
            print_usage(argv[0]);
            return 0;
        }
    }

    if (legacy_db_path.empty() || output_db_path.empty() || images_path.empty()) {
        print_usage(argv[0]);
        return 1;
    }

    if (!file_exists(legacy_db_path)) {
        std::cerr << "Legacy database not found: " << legacy_db_path << std::endl;
        return 2;
    }

    return run_migration();
}
