CXX = g++
CXXFLAGS = -std=c++17 -Wall -Wextra -O2
LDFLAGS = -lsqlite3 -lssl -lcrypto

SRC_DIR = src
BIN_DIR = bin
OUTPUT_DIR = output

SOURCES = $(SRC_DIR)/migrate.cpp
TARGET = $(BIN_DIR)/migrate

.PHONY: all clean dirs

all: dirs $(TARGET)

dirs:
	mkdir -p $(BIN_DIR) $(OUTPUT_DIR)

$(TARGET): $(SOURCES)
	$(CXX) $(CXXFLAGS) -o $@ $^ $(LDFLAGS)

clean:
	rm -rf $(BIN_DIR) $(OUTPUT_DIR)

run: all
	./$(TARGET) --legacy /app/legacy/features.db --output /app/output/features_v3.db --images /app/images
