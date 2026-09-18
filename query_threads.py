import sqlite3
import os

db_path = r"C:\Users\Charles\discord-claude-code-bot\threads-bockybot.db"

if not os.path.exists(db_path):
    print(f"Database not found at {db_path}")
    exit(1)

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row  # to get dict-like rows
cursor = conn.cursor()

# Get all tables
cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
tables = [row['name'] for row in cursor.fetchall()]

print("Found tables:", tables)

for table in tables:
    print(f"\n=== Latest 10 records from Table: {table} ===")
    try:
        cursor.execute(f"SELECT * FROM {table} ORDER BY rowid DESC LIMIT 10;")
        rows = cursor.fetchall()
        for row in reversed(rows): # Print in chronological order
            print(dict(row))
    except sqlite3.Error as e:
        print(f"Error reading from {table}: {e}")

conn.close()
