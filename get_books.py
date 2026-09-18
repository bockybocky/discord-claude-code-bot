import sqlite3
import os

db_path = r"C:\Users\Charles\discord-claude-code-bot\threads-selina.db"

if not os.path.exists(db_path):
    print("DB not found")
    exit(1)

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
cursor = conn.cursor()

try:
    cursor.execute("SELECT * FROM messages ORDER BY rowid DESC LIMIT 10;")
    rows = cursor.fetchall()
    for row in rows:
        print(dict(row))
except sqlite3.Error as e:
    print(f"Error querying messages: {e}")
    # try to find table names
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
    tables = [r['name'] for r in cursor.fetchall()]
    print("Available tables:", tables)
    for t in tables:
        try:
            cursor.execute(f"SELECT * FROM {t} ORDER BY rowid DESC LIMIT 10;")
            for r in cursor.fetchall():
                print(dict(r))
        except:
            pass

conn.close()
