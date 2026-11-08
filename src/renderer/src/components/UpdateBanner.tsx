import { Download, RefreshCw } from 'lucide-react'
import { startUpdate, useUpdates } from '../updates'

/** Başlık çubuğunun altındaki güncelleme şeridi */
export function UpdateBanner() {
  const { state: s, manual, dismissed, dismiss } = useUpdates()

  if (s.status === 'available' && dismissed !== s.version)
    return (
      <div className="update-banner">
        <Download size={16} />
        <span className="grow">
          <b>Yeni sürüm {s.version} hazır.</b>{' '}
          {manual
            ? "Yeni kurulum dosyasını indirip Rowly'yi Uygulamalar klasörüne sürükleyin. Ayarlarınız korunur."
            : `Güncelleme yaklaşık bir dakika sürer; Rowly kapanıp yeniden açılır.${window.platform === 'linux' ? ' Kurulum için parolanız istenebilir.' : ''} Bağlantılarınız ve ayarlarınız korunur.`}
        </span>
        <button className="btn sm light" onClick={startUpdate}>
          {manual ? 'İndir' : 'Şimdi güncelle'}
        </button>
        <button className="btn sm ghost-light" title="Sonra hatırlat" onClick={() => dismiss(s.version)}>
          Sonra
        </button>
      </div>
    )

  if (s.status === 'downloading')
    return (
      <div className="update-banner">
        <Download size={16} />
        <span className="grow">
          <b>Sürüm {s.version} indiriliyor…</b>
        </span>
        <span className="ubar">
          <span style={{ width: `${s.percent}%` }} />
        </span>
        <span className="upct">%{s.percent}</span>
      </div>
    )

  if (s.status === 'installing')
    return (
      <div className="update-banner green">
        <RefreshCw size={16} className="spin" />
        <span className="grow">
          <b>Sürüm {s.version} kuruluyor, Rowly birkaç saniye içinde yeniden açılacak…</b>
        </span>
      </div>
    )

  return null
}
