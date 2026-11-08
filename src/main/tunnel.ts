// SSH tüneli: SSH sunucusuna bağlanır, yerel bir porttan gelen bağlantıları sunucunun
// erişebildiği veritabanı adresine iletir. Veritabanı sürücüsü 127.0.0.1:<yerel port>'a bağlanır.
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Client, type ConnectConfig } from 'ssh2'
import type { SshConfig } from '@shared/types'

export interface Tunnel {
  localPort: number
  fingerprint: string
  close(): Promise<void>
}

/** OpenSSH ile aynı biçimde parmak izi: SHA256:<base64> */
const fingerprintOf = (key: Buffer) => 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')

const expandHome = (p: string) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)

/** ssh2 hata mesajlarını anlaşılır Türkçe açıklamalara çevirir. */
function explain(e: unknown, ssh: SshConfig): Error {
  const err = e as Error & { level?: string; code?: string }
  const m = err?.message ?? String(e)
  const where = `${ssh.host}:${ssh.port || 22}`
  if (err?.level === 'client-authentication' || /authentication methods failed/i.test(m))
    return new Error(
      `SSH kimlik doğrulaması başarısız (${ssh.user}@${where}). ${ssh.auth === 'password' ? 'Kullanıcı adı ve şifreyi' : ssh.auth === 'key' ? 'Kullanıcı adını ve özel anahtarı' : 'SSH agent içindeki anahtarları'} kontrol edin.`
    )
  if (/encrypted private.*passphrase|bad passphrase|Cannot parse privateKey|Unsupported key format/i.test(m))
    return new Error(`Özel anahtar okunamadı: ${/passphrase/i.test(m) ? 'anahtar parolalı; parolayı girin ya da doğru olduğundan emin olun' : 'desteklenmeyen ya da bozuk anahtar biçimi'}.`)
  if (err?.code === 'ENOTFOUND') return new Error(`SSH sunucusu bulunamadı: ${ssh.host}`)
  if (err?.code === 'ECONNREFUSED') return new Error(`SSH sunucusu bağlantıyı reddetti (${where}). Portu ve sunucunun çalıştığını kontrol edin.`)
  if (err?.level === 'client-timeout' || /timed out/i.test(m)) return new Error(`SSH sunucusuna bağlanırken zaman aşımı (${where}).`)
  if (/All configured agents|agent/i.test(m) && ssh.auth === 'agent') return new Error(`SSH agent'a ulaşılamadı. Windows'ta Pageant ya da OpenSSH Authentication Agent servisinin çalıştığından emin olun.`)
  return new Error(`SSH: ${m}`)
}

export async function openTunnel(ssh: SshConfig, dstHost: string, dstPort: number): Promise<Tunnel> {
  if (!ssh.host) throw new Error('SSH sunucu adresi boş.')
  if (!ssh.user) throw new Error('SSH kullanıcı adı boş.')
  const client = new Client()
  let fingerprint = ''
  let keyMismatch = false

  const cfg: ConnectConfig = {
    host: ssh.host,
    port: ssh.port || 22,
    username: ssh.user,
    readyTimeout: 15000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
    // Bilinmeyen sunucuya ilk bağlantıda anahtar kaydedilir (TOFU); sonra değişirse reddedilir
    hostVerifier: (key: Buffer) => {
      fingerprint = fingerprintOf(key)
      if (ssh.hostKey && ssh.hostKey !== fingerprint) {
        keyMismatch = true
        return false
      }
      return true
    }
  }
  if (ssh.auth === 'password') {
    cfg.password = ssh.password
    cfg.tryKeyboard = true
  } else if (ssh.auth === 'key') {
    if (!ssh.keyPath) throw new Error('Özel anahtar dosyası seçilmedi.')
    try {
      cfg.privateKey = fs.readFileSync(expandHome(ssh.keyPath))
    } catch {
      throw new Error(`Özel anahtar dosyası okunamadı: ${ssh.keyPath}`)
    }
    if (ssh.passphrase) cfg.passphrase = ssh.passphrase
  } else {
    cfg.agent = process.platform === 'win32' ? (process.env.SSH_AUTH_SOCK ?? 'pageant') : process.env.SSH_AUTH_SOCK
    if (!cfg.agent) throw new Error('SSH agent bulunamadı (SSH_AUTH_SOCK tanımlı değil).')
  }

  // Bazı sunucular şifreyi "keyboard-interactive" yöntemiyle ister
  client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => ssh.password)))

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve())
    client.once('error', (e) =>
      reject(
        keyMismatch
          ? new Error(
              `UYARI: SSH sunucusunun kimlik anahtarı değişmiş!\n\nKayıtlı: ${ssh.hostKey}\nŞimdiki: ${fingerprint}\n\nSunucu yeniden kurulduysa bağlantı ayarlarından kayıtlı anahtarı unutup tekrar bağlanın. Aksi halde araya biri girmiş (MITM) olabilir; bağlanmayın.`
            )
          : explain(e, ssh)
      )
    )
    try {
      client.connect(cfg)
    } catch (e) {
      reject(explain(e, ssh))
    }
  })
  client.on('error', () => {}) // bağlantı sonradan koparsa veritabanı sürücüsü hata verir

  // Hedefe ulaşılabildiğini baştan dene: yoksa anlaşılır hata ver
  await new Promise<void>((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, dstHost, dstPort, (err, stream) => {
      if (err) {
        client.end()
        const why = /prohibited/i.test(err.message)
          ? 'SSH sunucusu port yönlendirmeye izin vermiyor (sshd_config: AllowTcpForwarding yes olmalı).'
          : /open failed$/i.test(err.message)
            ? `SSH sunucusu ${dstHost}:${dstPort} adresine bağlanamadı. Veritabanı host/port bilgisini (SSH sunucusundan bakıldığında) kontrol edin; adres doğruysa sunucu bu kullanıcı için port yönlendirmeyi kapatmış olabilir (AllowTcpForwarding).`
            : `SSH sunucusu ${dstHost}:${dstPort} adresine bağlanamadı (${err.message.replace(/^\(SSH\)\s*/, '')}). Veritabanı host/port bilgisinin SSH sunucusundan bakıldığında doğru olduğundan emin olun.`
        reject(new Error(`Tünel kuruldu ama hedefe ulaşılamadı: ${why}`))
        return
      }
      stream.end()
      resolve()
    })
  })

  const sockets = new Set<net.Socket>()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    client.forwardOut(sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, dstHost, dstPort, (err, stream) => {
      if (err) {
        sock.destroy()
        return
      }
      sock.pipe(stream).pipe(sock)
      stream.on('error', () => sock.destroy())
      sock.on('error', () => stream.destroy())
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  client.on('close', () => server.close())

  const localPort = (server.address() as net.AddressInfo).port
  return {
    localPort,
    fingerprint,
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>((r) => server.close(() => r()))
      client.end()
    }
  }
}
