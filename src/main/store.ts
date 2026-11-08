import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import type { ConnectionConfig, SshConfig } from '@shared/types'

// Bağlantılar kullanıcı klasöründe JSON olarak tutulur; veritabanı şifresi, SSH şifresi ve
// anahtar parolası işletim sisteminin güvenli kasasıyla (Windows: DPAPI) şifrelenir.

/** Diskteki gizli değer: şifrelenmiş (enc) ya da kasa yoksa düz (plain) */
type Secret = { enc?: string; plain?: string }

type StoredSsh = Omit<SshConfig, 'password' | 'passphrase'> & { password?: Secret; passphrase?: Secret }
type Stored = Omit<ConnectionConfig, 'password' | 'ssh'> & {
  /** Eski sürümlerden kalan alanlar */
  password?: string
  passwordEnc?: string
  secret?: Secret
  ssh?: StoredSsh
}

const file = () => path.join(app.getPath('userData'), 'connections.json')

function seal(p: string): Secret | undefined {
  if (!p) return undefined
  if (safeStorage.isEncryptionAvailable()) return { enc: safeStorage.encryptString(p).toString('base64') }
  return { plain: p }
}

function open(s: Secret | undefined): string {
  if (!s) return ''
  if (s.enc) {
    try {
      return safeStorage.decryptString(Buffer.from(s.enc, 'base64'))
    } catch {
      return ''
    }
  }
  return s.plain ?? ''
}

function readAll(): Stored[] {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'))
  } catch {
    return []
  }
}

function writeAll(list: Stored[]) {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(list, null, 2))
}

function toConfig(s: Stored): ConnectionConfig {
  const { password: legacyPlain, passwordEnc: legacyEnc, secret, ssh, ...rest } = s
  const password = secret ? open(secret) : open({ enc: legacyEnc, plain: legacyPlain })
  const out: ConnectionConfig = { ...rest, password }
  if (ssh) {
    const { password: sp, passphrase: pp, ...sshRest } = ssh
    out.ssh = { ...sshRest, password: open(sp), passphrase: open(pp) }
  }
  return out
}

function toStored(c: ConnectionConfig): Stored {
  const { password, ssh, ...rest } = c
  const out: Stored = { ...rest, secret: seal(password) }
  if (ssh) {
    const { password: sp, passphrase: pp, ...sshRest } = ssh
    out.ssh = { ...sshRest, password: seal(sp), passphrase: seal(pp) }
  }
  return out
}

export function listConnections(): ConnectionConfig[] {
  return readAll().map(toConfig)
}

export function saveConnection(c: ConnectionConfig): ConnectionConfig[] {
  const list = readAll()
  const entry = toStored(c)
  const i = list.findIndex((x) => x.id === c.id)
  if (i >= 0) list[i] = entry
  else list.push(entry)
  writeAll(list)
  return listConnections()
}

export function deleteConnection(id: string): ConnectionConfig[] {
  writeAll(readAll().filter((x) => x.id !== id))
  return listConnections()
}
