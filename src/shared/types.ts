// Ana süreç (main) ile arayüz (renderer) arasında paylaşılan tipler.

export type DbType = 'mysql' | 'mariadb' | 'postgres' | 'cockroach' | 'redshift' | 'sqlite' | 'mssql' | 'mongodb' | 'redis'

/** Sorgu dili ve arayüz davranışını belirleyen veritabanı ailesi */
export type DbFamily = 'sql' | 'mongo' | 'redis'

export type EnvTag = 'local' | 'development' | 'staging' | 'production' | 'testing'

export interface ConnectionConfig {
  id: string
  name: string
  type: DbType
  host: string
  port: number
  user: string
  password: string
  database: string
  /** SQLite için dosya yolu */
  file: string
  ssl: boolean
  tag: EnvTag
  color: string
  /** MongoDB için isteğe bağlı bağlantı adresi (mongodb:// veya mongodb+srv://). Doluysa diğer alanlar yok sayılır. */
  uri?: string
  /** Veritabanına SSH sunucusu üzerinden (tünel) bağlanma */
  ssh?: SshConfig
}

export type SshAuth = 'password' | 'key' | 'agent'

export interface SshConfig {
  enabled: boolean
  host: string
  port: number
  user: string
  auth: SshAuth
  password: string
  /** Özel anahtar dosyasının yolu (OpenSSH / PEM / PuTTY .ppk) */
  keyPath: string
  /** Anahtarın parolası (varsa) */
  passphrase: string
  /** İlk bağlantıda kaydedilen sunucu anahtarı parmak izi (SHA256:…); sonra değişirse bağlantı reddedilir */
  hostKey?: string
}

export const emptySsh = (): SshConfig => ({ enabled: false, host: '', port: 22, user: '', auth: 'password', password: '', keyPath: '', passphrase: '' })

export interface DbTypeInfo {
  type: DbType
  label: string
  family: DbFamily
  defaultPort: number
  defaultUser: string
  fileBased?: boolean
  hasSchemas?: boolean
  color: string
  short: string
}

export const DB_TYPES: DbTypeInfo[] = [
  { type: 'mysql', label: 'MySQL', family: 'sql', defaultPort: 3306, defaultUser: 'root', color: '#00758f', short: 'My' },
  { type: 'mariadb', label: 'MariaDB', family: 'sql', defaultPort: 3306, defaultUser: 'root', color: '#c0765a', short: 'Ma' },
  { type: 'postgres', label: 'PostgreSQL', family: 'sql', defaultPort: 5432, defaultUser: 'postgres', hasSchemas: true, color: '#336791', short: 'Pg' },
  { type: 'cockroach', label: 'CockroachDB', family: 'sql', defaultPort: 26257, defaultUser: 'root', hasSchemas: true, color: '#6933ff', short: 'Cr' },
  { type: 'redshift', label: 'Amazon Redshift', family: 'sql', defaultPort: 5439, defaultUser: 'awsuser', hasSchemas: true, color: '#8c4fff', short: 'Rs' },
  { type: 'mssql', label: 'SQL Server', family: 'sql', defaultPort: 1433, defaultUser: 'sa', hasSchemas: true, color: '#cc2927', short: 'Ms' },
  { type: 'sqlite', label: 'SQLite', family: 'sql', defaultPort: 0, defaultUser: '', fileBased: true, color: '#0f80cc', short: 'Sl' },
  { type: 'mongodb', label: 'MongoDB', family: 'mongo', defaultPort: 27017, defaultUser: '', color: '#47a248', short: 'Mo' },
  { type: 'redis', label: 'Redis', family: 'redis', defaultPort: 6379, defaultUser: '', color: '#dc382d', short: 'Rd' }
]

export const dbTypeInfo = (t: DbType): DbTypeInfo => DB_TYPES.find((d) => d.type === t) ?? DB_TYPES[0]

export const ENV_TAGS: { tag: EnvTag; label: string; color: string }[] = [
  { tag: 'local', label: 'Local', color: '#34a853' },
  { tag: 'development', label: 'Development', color: '#4285f4' },
  { tag: 'testing', label: 'Testing', color: '#9c27b0' },
  { tag: 'staging', label: 'Staging', color: '#f9a825' },
  { tag: 'production', label: 'Production', color: '#e53935' }
]

/** Hücre değeri: arayüze her zaman sade tiplerle gelir. */
export type Cell = string | number | boolean | null

export interface TableInfo {
  schema: string
  name: string
  kind: 'table' | 'view'
  /** Redis anahtar grupları gibi, önceden bilinen öğe sayısı */
  count?: number
}

export interface TableRef {
  schema: string
  name: string
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  defaultValue: string | null
  primaryKey: boolean
  autoIncrement: boolean
  extra: string
  comment: string
  /** MySQL: sütunun karakter karşılaştırma kuralı (yeniden tanımlarken korunur) */
  collation?: string
  /** MySQL: ON UPDATE ifadesi (ör. current_timestamp()) */
  onUpdate?: string
  /** Hesaplanan (generated) sütun: yapı düzenleyicide değiştirilemez */
  generated?: boolean
}

export interface IndexInfo {
  name: string
  columns: string
  unique: boolean
  primary: boolean
  /** İndeks bir kısıta (PRIMARY KEY / UNIQUE) aittir; DROP INDEX yerine DROP CONSTRAINT gerekir */
  constraint?: boolean
}

export type FkAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT'

export interface ForeignKeyInfo {
  name: string
  columns: string[]
  refSchema: string
  refTable: string
  refColumns: string[]
  onDelete: FkAction
  onUpdate: FkAction
}

export interface ResultColumn {
  name: string
  type?: string
}

export interface QueryResult {
  columns: ResultColumn[]
  rows: Cell[][]
  rowsAffected: number | null
  durationMs: number
  /** Satır döndürmeyen komutlarda (INSERT/UPDATE) true */
  isCommand: boolean
}

export type FilterOp =
  | '='
  | '!='
  | '<'
  | '>'
  | '<='
  | '>='
  | 'LIKE'
  | 'NOT LIKE'
  | 'CONTAINS'
  | 'IN'
  | 'IS NULL'
  | 'IS NOT NULL'

export const FILTER_OPS: FilterOp[] = ['=', '!=', '<', '>', '<=', '>=', 'CONTAINS', 'LIKE', 'NOT LIKE', 'IN', 'IS NULL', 'IS NOT NULL']

export interface Filter {
  column: string
  op: FilterOp
  value: string
}

export interface FetchOptions {
  table: TableRef
  limit: number
  offset: number
  orderBy?: { column: string; dir: 'ASC' | 'DESC' } | null
  /** Toplam satır sayımını atla (dışa aktarmada her parti için gereksiz) */
  skipCount?: boolean
  filters?: Filter[]
}

export interface FetchResult {
  result: QueryResult
  total: number
}

export type RowChange =
  | { kind: 'update'; pk: Record<string, Cell>; values: Record<string, Cell> }
  | { kind: 'insert'; values: Record<string, Cell> }
  | { kind: 'delete'; pk: Record<string, Cell> }

export interface ServerInfo {
  version: string
  currentDatabase: string
  /** SSH tüneli kullanıldıysa sunucunun anahtar parmak izi */
  sshFingerprint?: string
}

// ---------- Güncellemeler ----------

export type UpdateState =
  | { status: 'idle' | 'dev' | 'checking' | 'none' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'installing'; version: string }
  | { status: 'error'; message: string }

export interface UpdateInfo {
  version: string
  state: UpdateState
  /** macOS: uygulama kendini güncelleyemez, yeni .dmg tarayıcıda indirilir */
  manual: boolean
}

/** IPC cevap zarfı: hatalar temiz mesajla taşınır. */
export type IpcResponse<T> = { ok: true; data: T } | { ok: false; error: string }

// ---------- Dışa / içe aktarma ----------

export type ExportFormat = 'csv' | 'json' | 'sql'

export interface CsvOptions {
  delimiter: string
  header: boolean
  /** Excel'in UTF-8'i tanıması için dosya başına BOM ekle */
  bom: boolean
}

export interface ExportOptions {
  jobId: string
  tables: TableInfo[]
  format: ExportFormat
  /** Tek dosya (tek tablo veya SQL) ya da klasör (çok tablolu CSV/JSON) */
  target: string
  /** Yalnızca tek tablo dışa aktarılırken uygulanır */
  filters?: Filter[]
  orderBy?: FetchOptions['orderBy']
  csv: CsvOptions
  sql: { structure: boolean; data: boolean; drop: boolean }
}

export type ImportKind = 'csv' | 'json' | 'sql'

export interface ImportPreview {
  kind: ImportKind
  size: number
  delimiter?: string
  columns: string[]
  rows: Cell[][]
  totalRows?: number
  statements?: number
  /** SQL betiğinin ilk satırları */
  sample?: string
}

export interface ImportOptions {
  jobId: string
  file: string
  kind: ImportKind
  table?: TableInfo
  /** Dosya sütunu → tablo sütunu (null = atla) */
  mapping?: { source: string; target: string | null }[]
  delimiter?: string
  header?: boolean
  emptyAsNull?: boolean
  truncate?: boolean
  /** NoSQL: aynı anahtar/_id varsa üzerine yaz */
  overwrite?: boolean
  stopOnError?: boolean
}

export interface TransferProgress {
  jobId: string
  done: number
  total: number | null
  message: string
}

export interface TransferSummary {
  rows: number
  files: string[]
  errors: string[]
  ms: number
  cancelled: boolean
}
