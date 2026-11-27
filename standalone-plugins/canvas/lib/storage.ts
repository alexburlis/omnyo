const historyMigrations = [
  `CREATE TABLE canvas_field_versions(thread_id TEXT NOT NULL, target TEXT NOT NULL, field TEXT NOT NULL, writer INTEGER NOT NULL, version INTEGER NOT NULL, writer_actor TEXT NOT NULL, PRIMARY KEY(thread_id, target, field))`,
  `CREATE TABLE canvas_history(thread_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, actor TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, fields_json TEXT NOT NULL, activity_revision INTEGER NOT NULL, activity_actor TEXT NOT NULL, activity_action TEXT NOT NULL, activity_at INTEGER NOT NULL, PRIMARY KEY(thread_id, id))`,
];

export const sourceMigrations = [
  "CREATE TABLE canvas_sources(thread_id TEXT NOT NULL, id TEXT NOT NULL, definition_json TEXT NOT NULL, record_json TEXT NOT NULL, dataset_json TEXT, next_refresh_at INTEGER, lease_until INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(thread_id,id))",
];

const mediaMigrations = [
  `CREATE TABLE canvas_media(asset_id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL)`,
  `CREATE TABLE canvas_media_variants(asset_id TEXT NOT NULL, width INTEGER NOT NULL, content BLOB NOT NULL, PRIMARY KEY(asset_id, width))`,
  `CREATE TABLE canvas_media_failures(asset_id TEXT PRIMARY KEY, message TEXT NOT NULL)`,
];

const projectMigrations = [
  "CREATE TABLE canvas_projects(project_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 0,home_view_id TEXT)",
  "CREATE TABLE canvas_regions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,question TEXT,x REAL NOT NULL,y REAL NOT NULL,ord REAL NOT NULL,locked INTEGER NOT NULL DEFAULT 0,archived_at INTEGER,origin_thread_id TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL)",
  "CREATE TABLE canvas_views(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,ord REAL NOT NULL,anchor_kind TEXT NOT NULL,region_id TEXT,anchor_id TEXT,rect_json TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL)",
  "CREATE TABLE canvas_chats(thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,region_id TEXT,anchor_kind TEXT NOT NULL,anchor_id TEXT,x REAL NOT NULL,y REAL NOT NULL,role TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL)",
  "CREATE TABLE canvas_board_aliases(old_key TEXT PRIMARY KEY,board_key TEXT NOT NULL)",
  "CREATE TABLE canvas_project_journal(project_id TEXT NOT NULL,id TEXT PRIMARY KEY,actor TEXT NOT NULL,label TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at INTEGER NOT NULL,state TEXT NOT NULL)",
  "CREATE INDEX canvas_regions_project ON canvas_regions(project_id)",
  "CREATE INDEX canvas_views_project_order ON canvas_views(project_id,ord)",
  "CREATE INDEX canvas_chats_project ON canvas_chats(project_id)",
  "CREATE INDEX canvas_chats_region ON canvas_chats(region_id)",
  "ALTER TABLE canvas_projects ADD COLUMN archived_at INTEGER",
];

export const canvasMigrations = [
  `CREATE TABLE canvas_threads(thread_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, seen_revision INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE sections(thread_id TEXT NOT NULL, name TEXT NOT NULL, ord INTEGER NOT NULL, PRIMARY KEY(thread_id, name))`,
  `CREATE TABLE nodes(thread_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, ord REAL NOT NULL, section TEXT NOT NULL, title TEXT, body TEXT, tone TEXT NOT NULL, pinned INTEGER NOT NULL, href TEXT, language TEXT, html TEXT, options_json TEXT NOT NULL, recommended TEXT, progress REAL, state TEXT, asset_id TEXT, x REAL, y REAL, archived INTEGER NOT NULL DEFAULT 0, created_revision INTEGER NOT NULL, updated_revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(thread_id, id))`,
  `CREATE TABLE edges(thread_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, label TEXT, PRIMARY KEY(thread_id, from_id, to_id))`,
  `CREATE TABLE assets(id TEXT PRIMARY KEY, mime TEXT NOT NULL, content BLOB NOT NULL)`,
  `ALTER TABLE canvas_threads ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE nodes ADD COLUMN wide INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE canvas_threads ADD COLUMN started_by TEXT NOT NULL DEFAULT 'user'`,
  `ALTER TABLE canvas_threads ADD COLUMN composition_json TEXT`,
  `ALTER TABLE nodes ADD COLUMN extras_json TEXT NOT NULL DEFAULT '{}'`,
  ...historyMigrations,
  ...sourceMigrations,
  `ALTER TABLE canvas_threads ADD COLUMN layout_json TEXT`,
  `ALTER TABLE canvas_threads ADD COLUMN islands_json TEXT`,
  `ALTER TABLE canvas_threads ADD COLUMN moved_to TEXT`,
  `ALTER TABLE canvas_threads ADD COLUMN carried_from TEXT`,
  ...mediaMigrations,
  ...projectMigrations,
  "CREATE TABLE canvas_change_actors(thread_id TEXT NOT NULL,change_id TEXT NOT NULL,actor_thread_id TEXT NOT NULL,PRIMARY KEY(thread_id,change_id,actor_thread_id))",
  "CREATE INDEX canvas_change_actors_chat ON canvas_change_actors(actor_thread_id,thread_id)",
];

const boardContentTables = [
  "sections",
  "nodes",
  "edges",
  "canvas_history",
  "canvas_field_versions",
] as const;

const boardAttributionTables = ["canvas_change_actors"] as const;

export const boardTables = [...boardContentTables, ...boardAttributionTables] as const;

export const ownedBoardTables = [
  ...boardContentTables,
  "canvas_sources",
  ...boardAttributionTables,
] as const;
