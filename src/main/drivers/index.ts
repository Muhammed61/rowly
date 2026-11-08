import type { ConnectionConfig } from '@shared/types'
import type { Driver } from './base'
import { MySqlDriver } from './mysql'
import { PostgresDriver } from './postgres'
import { SqliteDriver } from './sqlite'
import { MsSqlDriver } from './mssql'
import { MongoDriver } from './mongo'
import { RedisDriver } from './redis'

export function createDriver(cfg: ConnectionConfig): Driver {
  switch (cfg.type) {
    case 'mysql':
    case 'mariadb':
      return new MySqlDriver(cfg)
    case 'postgres':
    case 'cockroach':
    case 'redshift':
      return new PostgresDriver(cfg)
    case 'sqlite':
      return new SqliteDriver(cfg)
    case 'mssql':
      return new MsSqlDriver(cfg)
    case 'mongodb':
      return new MongoDriver(cfg)
    case 'redis':
      return new RedisDriver(cfg)
    default:
      throw new Error(`Desteklenmeyen veritabanı türü: ${(cfg as ConnectionConfig).type}`)
  }
}
