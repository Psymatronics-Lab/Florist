-- Files attached to chats; the doc holds the extracted text.
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  created TEXT NOT NULL,
  doc TEXT NOT NULL
);
