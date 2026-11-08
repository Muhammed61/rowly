import { useState } from 'react'
import { CheckCircle2, FolderOpen, FilePlus2, KeyRound, Loader2, XCircle } from 'lucide-react'
import { DB_TYPES, dbTypeInfo, emptySsh, ENV_TAGS, type ConnectionConfig, type DbType, type SshConfig } from '@shared/types'
import { useStore } from '../store'
import { DbBadge, Modal } from './ui'

export function emptyConnection(type: DbType = 'mysql'): ConnectionConfig {
  const info = dbTypeInfo(type)
  return {
    id: crypto.randomUUID(),
    name: '',
    type,
    host: info.fileBased ? '' : '127.0.0.1',
    port: info.defaultPort,
    user: info.defaultUser,
    password: '',
    database: '',
    file: '',
    ssl: false,
    tag: 'local',
    color: ENV_TAGS[0].color
  }
}

const defaultName = (c: ConnectionConfig) => {
  const info = dbTypeInfo(c.type)
  if (info.fileBased) return c.file.split(/[\\/]/).pop() || info.label
  const uriHost = c.uri?.trim() ? /^[a-z+]+:\/\/(?:[^@/]*@)?([^/:?,]+)/i.exec(c.uri.trim())?.[1] : undefined
  return `${info.label} @ ${uriHost || c.host || 'localhost'}`
}

export function ConnectionForm({ initial, onClose }: { initial: ConnectionConfig; onClose: () => void }) {
  const [c, setC] = useState<ConnectionConfig>(initial)
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'err'; text?: string }>({ state: 'idle' })
  const saveConnection = useStore((s) => s.saveConnection)
  const connect = useStore((s) => s.connect)
  const info = dbTypeInfo(c.type)

  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) => {
    setC((p) => ({ ...p, [k]: v }))
    setTest({ state: 'idle' })
  }

  const setType = (type: DbType) => {
    const prev = dbTypeInfo(c.type)
    const next = dbTypeInfo(type)
    setC((p) => ({
      ...p,
      type,
      port: !p.port || p.port === prev.defaultPort ? next.defaultPort : p.port,
      user: !p.user || p.user === prev.defaultUser ? next.defaultUser : p.user,
      host: next.fileBased ? p.host : p.host || '127.0.0.1',
      uri: next.family === prev.family ? p.uri : ''
    }))
    setTest({ state: 'idle' })
  }

  const final = (): ConnectionConfig => ({ ...c, name: c.name.trim() || defaultName(c) })

  const runTest = async () => {
    setTest({ state: 'busy' })
    try {
      const r = await window.api.testConnection(final())
      // SSH sunucu anahtarını ilk başarılı testte formda tut; kaydedince bağlantıyla saklanır
      if (c.ssh?.enabled && r.sshFingerprint && !c.ssh.hostKey) setC((p) => ({ ...p, ssh: { ...p.ssh!, hostKey: r.sshFingerprint } }))
      setTest({ state: 'ok', text: `Bağlantı başarılı · ${r.version}${c.ssh?.enabled ? ' · SSH tüneli üzerinden' : ''}` })
    } catch (e) {
      setTest({ state: 'err', text: (e as Error).message })
    }
  }

  const save = async (andConnect: boolean) => {
    if (info.fileBased && !c.file) {
      setTest({ state: 'err', text: 'Lütfen bir SQLite dosyası seçin.' })
      return
    }
    const f = final()
    try {
      await saveConnection(f)
      onClose()
      if (andConnect) await connect(f)
    } catch (e) {
      setTest({ state: 'err', text: (e as Error).message })
    }
  }

  const pickFile = async (mode: 'open' | 'save') => {
    const p = await window.api.pickSqliteFile(mode)
    if (p) set('file', p)
  }

  return (
    <Modal onClose={onClose}>
      <div className="modal-head">{initial.name ? 'Bağlantıyı düzenle' : 'Yeni bağlantı'}</div>
      <div className="modal-body">
        <div className="type-grid">
          {DB_TYPES.map((t) => (
            <div key={t.type} className={`type-card${c.type === t.type ? ' active' : ''}`} onClick={() => setType(t.type)}>
              <DbBadge type={t.type} size={24} />
              {t.label}
            </div>
          ))}
        </div>

        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault()
            save(true)
          }}
        >
          <label>Ad</label>
          <input className="input" autoFocus placeholder={defaultName(c)} value={c.name} onChange={(e) => set('name', e.target.value)} />

          <label>Ortam</label>
          <div className="tag-picker">
            {ENV_TAGS.map((t) => (
              <button
                type="button"
                key={t.tag}
                className={c.tag === t.tag ? 'active' : ''}
                onClick={() => setC((p) => ({ ...p, tag: t.tag, color: t.color }))}
              >
                <span className="dot" style={{ background: t.color }} />
                {t.label}
              </button>
            ))}
          </div>

          {info.fileBased ? (
            <>
              <label>Dosya</label>
              <div className="form-row">
                <input className="input mono" placeholder="C:\yol\veritabani.sqlite" value={c.file} onChange={(e) => set('file', e.target.value)} />
                <button type="button" className="btn" onClick={() => pickFile('open')}>
                  <FolderOpen size={14} /> Seç
                </button>
                <button type="button" className="btn" onClick={() => pickFile('save')} title="Yeni boş veritabanı oluştur">
                  <FilePlus2 size={14} /> Yeni
                </button>
              </div>
            </>
          ) : (
            <>
              {info.family !== 'sql' && (
                <>
                  <label>Bağlantı URI</label>
                  <input
                    className="input mono"
                    placeholder={
                      info.family === 'mongo'
                        ? 'isteğe bağlı · mongodb+srv://kullanici:sifre@cluster.mongodb.net/veritabani'
                        : 'isteğe bağlı · redis://:sifre@host:6379/0 veya rediss://…'
                    }
                    value={c.uri ?? ''}
                    onChange={(e) => set('uri', e.target.value)}
                  />
                </>
              )}
              <fieldset disabled={!!c.uri?.trim()} style={{ display: 'contents' }}>
                <label style={{ opacity: c.uri?.trim() ? 0.5 : 1 }}>Host / Port</label>
                <div className="form-row" style={{ opacity: c.uri?.trim() ? 0.5 : 1 }}>
                  <input className="input" placeholder="127.0.0.1" value={c.host} onChange={(e) => set('host', e.target.value)} />
                  <input
                    className="input"
                    style={{ flex: '0 0 90px' }}
                    type="number"
                    value={c.port || ''}
                    onChange={(e) => set('port', Number(e.target.value))}
                  />
                </div>

                <label style={{ opacity: c.uri?.trim() ? 0.5 : 1 }}>Kullanıcı</label>
                <input
                  className="input"
                  style={{ opacity: c.uri?.trim() ? 0.5 : 1 }}
                  placeholder={info.family === 'sql' ? '' : '(isteğe bağlı)'}
                  value={c.user}
                  onChange={(e) => set('user', e.target.value)}
                />

                <label style={{ opacity: c.uri?.trim() ? 0.5 : 1 }}>Şifre</label>
                <input
                  className="input"
                  style={{ opacity: c.uri?.trim() ? 0.5 : 1 }}
                  type="password"
                  placeholder="(boş)"
                  value={c.password}
                  onChange={(e) => set('password', e.target.value)}
                />

                <label style={{ opacity: c.uri?.trim() ? 0.5 : 1 }}>{info.family === 'redis' ? 'Veritabanı no' : 'Veritabanı'}</label>
                <input
                  className="input"
                  style={{ opacity: c.uri?.trim() ? 0.5 : 1 }}
                  type={info.family === 'redis' ? 'number' : 'text'}
                  min={0}
                  placeholder={info.family === 'redis' ? '0' : info.hasSchemas ? 'postgres' : 'boş bırakılırsa sonra seçilir'}
                  value={c.database}
                  onChange={(e) => set('database', e.target.value)}
                />

                <label />
                <label className="check" style={{ textAlign: 'left', opacity: c.uri?.trim() ? 0.5 : 1 }}>
                  <input type="checkbox" checked={c.ssl} onChange={(e) => set('ssl', e.target.checked)} />
                  SSL/TLS kullan
                </label>
              </fieldset>
              <SshSection
                ssh={c.ssh ?? emptySsh()}
                onChange={(ssh) => {
                  setC((p) => ({ ...p, ssh }))
                  setTest({ state: 'idle' })
                }}
              />
            </>
          )}
          <button type="submit" hidden />
        </form>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={runTest} disabled={test.state === 'busy'}>
          {test.state === 'busy' ? <Loader2 size={14} className="spin" /> : null}
          Test et
        </button>
        <div className={`test-result spacer ${test.state === 'ok' ? 'ok' : test.state === 'err' ? 'err' : ''}`} title={test.text}>
          {test.state === 'ok' && <CheckCircle2 size={15} />}
          {test.state === 'err' && <XCircle size={15} />}
          <span>{test.text}</span>
        </div>
        <button className="btn" onClick={onClose}>
          Vazgeç
        </button>
        <button className="btn" onClick={() => save(false)}>
          Kaydet
        </button>
        <button className="btn primary" onClick={() => save(true)}>
          Bağlan
        </button>
      </div>
    </Modal>
  )
}

/** Bağlantı formundaki SSH tüneli bölümü */
function SshSection({ ssh, onChange }: { ssh: SshConfig; onChange(s: SshConfig): void }) {
  const set = <K extends keyof SshConfig>(k: K, v: SshConfig[K]) => onChange({ ...ssh, [k]: v })
  const pickKey = async () => {
    const p = await window.api.pickKeyFile()
    if (p) set('keyPath', p)
  }
  return (
    <>
      <div className="form-sep" />
      <label />
      <label className="check" style={{ textAlign: 'left', fontWeight: 600 }}>
        <input type="checkbox" checked={ssh.enabled} onChange={(e) => onChange({ ...ssh, enabled: e.target.checked })} />
        <KeyRound size={13} /> SSH tüneli üzerinden bağlan
      </label>
      {ssh.enabled && (
        <>
          <label>SSH sunucu</label>
          <div className="form-row">
            <input className="input" placeholder="sunucu.ornek.com" value={ssh.host} onChange={(e) => set('host', e.target.value)} />
            <input className="input" style={{ flex: '0 0 90px' }} type="number" value={ssh.port || ''} onChange={(e) => set('port', Number(e.target.value))} />
          </div>

          <label>SSH kullanıcı</label>
          <input className="input" placeholder="root, ubuntu…" value={ssh.user} onChange={(e) => set('user', e.target.value)} />

          <label>Kimlik doğrulama</label>
          <div className="segmented" style={{ justifySelf: 'start' }}>
            {(
              [
                ['password', 'Şifre'],
                ['key', 'Özel anahtar'],
                ['agent', 'SSH agent']
              ] as const
            ).map(([v, l]) => (
              <button type="button" key={v} className={ssh.auth === v ? 'active' : ''} onClick={() => set('auth', v)}>
                {l}
              </button>
            ))}
          </div>

          {ssh.auth === 'password' && (
            <>
              <label>SSH şifresi</label>
              <input className="input" type="password" value={ssh.password} onChange={(e) => set('password', e.target.value)} />
            </>
          )}
          {ssh.auth === 'key' && (
            <>
              <label>Anahtar dosyası</label>
              <div className="form-row">
                <input className="input mono" placeholder="C:\Users\…\.ssh\id_ed25519" value={ssh.keyPath} onChange={(e) => set('keyPath', e.target.value)} />
                <button type="button" className="btn" onClick={pickKey}>
                  <FolderOpen size={14} /> Seç
                </button>
              </div>
              <label>Anahtar parolası</label>
              <input className="input" type="password" placeholder="(yoksa boş bırak)" value={ssh.passphrase} onChange={(e) => set('passphrase', e.target.value)} />
            </>
          )}
          {ssh.auth === 'agent' && (
            <>
              <label />
              <div className="muted" style={{ fontSize: 12 }}>
                Windows'ta Pageant ya da OpenSSH Authentication Agent servisindeki anahtarlar kullanılır.
              </div>
            </>
          )}

          <label>Sunucu anahtarı</label>
          {ssh.hostKey ? (
            <div className="form-row">
              <span className="mono muted" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis' }} title={ssh.hostKey}>
                {ssh.hostKey}
              </span>
              <button type="button" className="btn sm" title="Sunucu yeniden kurulduysa kayıtlı anahtarı unut" onClick={() => onChange({ ...ssh, hostKey: undefined })}>
                Unut
              </button>
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 12 }}>
              İlk bağlantıda kaydedilir; sonradan değişirse bağlantı güvenlik için reddedilir.
            </div>
          )}

          <label />
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
            Yukarıdaki Host / Port, veritabanının <b>SSH sunucusundan bakıldığında</b> adresidir (veritabanı aynı sunucudaysa genelde 127.0.0.1).
          </div>
        </>
      )}
    </>
  )
}
