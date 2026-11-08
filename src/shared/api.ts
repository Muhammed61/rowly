import type {
  ColumnInfo,
  ConnectionConfig,
  FetchOptions,
  FetchResult,
  IndexInfo,
  QueryResult,
  RowChange,
  ExportOptions,
  ForeignKeyInfo,
  UpdateInfo,
  ImportOptions,
  ImportPreview,
  TransferSummary,
  ServerInfo,
  TableInfo,
  TableRef
} from './types'

/** Arayüzün ana süreçten çağırabildiği tüm fonksiyonlar. */
export interface Api {
  listConnections(): Promise<ConnectionConfig[]>
  saveConnection(c: ConnectionConfig): Promise<ConnectionConfig[]>
  deleteConnection(id: string): Promise<ConnectionConfig[]>
  testConnection(c: ConnectionConfig): Promise<ServerInfo>
  openSession(c: ConnectionConfig): Promise<{ sessionId: string; info: ServerInfo }>
  closeSession(sid: string): Promise<void>
  serverInfo(sid: string): Promise<ServerInfo>
  listDatabases(sid: string): Promise<string[]>
  useDatabase(sid: string, name: string): Promise<ServerInfo>
  listTables(sid: string): Promise<TableInfo[]>
  getColumns(sid: string, ref: TableRef): Promise<ColumnInfo[]>
  getIndexes(sid: string, ref: TableRef): Promise<IndexInfo[]>
  getDDL(sid: string, ref: TableRef): Promise<string>
  getForeignKeys(sid: string, ref: TableRef): Promise<ForeignKeyInfo[]>
  /** Yapı değişikliği ifadelerini sırayla çalıştırır (destekleyen veritabanlarında tek işlem içinde) */
  applyDDL(sid: string, statements: string[]): Promise<void>
  fetchRows(sid: string, opts: FetchOptions): Promise<FetchResult>
  rawQuery(sid: string, sql: string): Promise<QueryResult[]>
  applyChanges(sid: string, ref: TableRef, changes: RowChange[]): Promise<number>
  pickSqliteFile(mode: 'open' | 'save'): Promise<string | null>
  pickKeyFile(): Promise<string | null>
  setTitleBarTheme(dark: boolean): Promise<void>

  // Dışa / içe aktarma
  exportData(sid: string, opts: ExportOptions): Promise<TransferSummary>
  previewImport(file: string, delimiter?: string): Promise<ImportPreview>
  importData(sid: string, opts: ImportOptions): Promise<TransferSummary>
  cancelJob(jobId: string): Promise<void>
  pickSavePath(defaultName: string, extensions: string[]): Promise<string | null>
  pickFolder(): Promise<string | null>
  pickImportFile(): Promise<string | null>
  saveResult(result: QueryResult, format: 'csv' | 'json', name: string): Promise<string | null>
  showInFolder(path: string): Promise<void>

  // Güncellemeler
  updateInfo(): Promise<UpdateInfo>
  updateCheck(): Promise<{ message: string }>
  updateDownload(): Promise<boolean>
  openExternal(url: string): Promise<void>
}

export const API_METHODS: (keyof Api)[] = [
  'listConnections',
  'saveConnection',
  'deleteConnection',
  'testConnection',
  'openSession',
  'closeSession',
  'serverInfo',
  'listDatabases',
  'useDatabase',
  'listTables',
  'getColumns',
  'getIndexes',
  'getDDL',
  'getForeignKeys',
  'applyDDL',
  'fetchRows',
  'rawQuery',
  'applyChanges',
  'pickSqliteFile',
  'pickKeyFile',
  'setTitleBarTheme',
  'exportData',
  'previewImport',
  'importData',
  'cancelJob',
  'pickSavePath',
  'pickFolder',
  'pickImportFile',
  'saveResult',
  'showInFolder',
  'updateInfo',
  'updateCheck',
  'updateDownload',
  'openExternal'
]
