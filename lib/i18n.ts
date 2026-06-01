// [BATCH-A] tiny i18n — button/label strings only
import { lsGet, lsSet } from './storage'

export type Locale = 'en' | 'es' | 'fr' | 'de' | 'ja' | 'zh'
export const LOCALES: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' },
]

type Dict = Record<string, string>
const DICTS: Record<Locale, Dict> = {
  en: { settings:'Settings', display:'Display', audio:'Audio', data:'Data', privacy:'Privacy',
        theme:'Theme', light:'Light', dark:'Dark', system:'System', contrast:'High contrast',
        fontSize:'Font size', mute:'Mute all', volume:'Volume', chime:'Watchlist chime',
        refresh:'Refresh', clearPrefs:'Clear all preferences', storageUsed:'Storage used',
        locale:'Language', install:'Install app', offline:'Offline', close:'Close', screenshot:'Screenshot',
        exportLog:'Export play log' },
  es: { settings:'Ajustes', display:'Pantalla', audio:'Audio', data:'Datos', privacy:'Privacidad',
        theme:'Tema', light:'Claro', dark:'Oscuro', system:'Sistema', contrast:'Alto contraste',
        fontSize:'Tamaño de fuente', mute:'Silenciar', volume:'Volumen', chime:'Tono de lista',
        refresh:'Actualizar', clearPrefs:'Borrar preferencias', storageUsed:'Almacenamiento',
        locale:'Idioma', install:'Instalar', offline:'Sin conexión', close:'Cerrar', screenshot:'Captura',
        exportLog:'Exportar registro' },
  fr: { settings:'Paramètres', display:'Affichage', audio:'Audio', data:'Données', privacy:'Confidentialité',
        theme:'Thème', light:'Clair', dark:'Sombre', system:'Système', contrast:'Contraste élevé',
        fontSize:'Taille de police', mute:'Couper le son', volume:'Volume', chime:'Carillon',
        refresh:'Rafraîchir', clearPrefs:'Effacer les préférences', storageUsed:'Stockage',
        locale:'Langue', install:'Installer', offline:'Hors ligne', close:'Fermer', screenshot:'Capture',
        exportLog:'Exporter journal' },
  de: { settings:'Einstellungen', display:'Anzeige', audio:'Audio', data:'Daten', privacy:'Privatsphäre',
        theme:'Design', light:'Hell', dark:'Dunkel', system:'System', contrast:'Hoher Kontrast',
        fontSize:'Schriftgröße', mute:'Stumm', volume:'Lautstärke', chime:'Watchlist-Ton',
        refresh:'Aktualisieren', clearPrefs:'Einstellungen löschen', storageUsed:'Speicher',
        locale:'Sprache', install:'Installieren', offline:'Offline', close:'Schließen', screenshot:'Bildschirmfoto',
        exportLog:'Protokoll exportieren' },
  ja: { settings:'設定', display:'表示', audio:'音声', data:'データ', privacy:'プライバシー',
        theme:'テーマ', light:'ライト', dark:'ダーク', system:'システム', contrast:'ハイコントラスト',
        fontSize:'文字サイズ', mute:'消音', volume:'音量', chime:'通知音',
        refresh:'更新間隔', clearPrefs:'設定を消去', storageUsed:'ストレージ',
        locale:'言語', install:'インストール', offline:'オフライン', close:'閉じる', screenshot:'スクショ',
        exportLog:'ログ出力' },
  zh: { settings:'设置', display:'显示', audio:'音频', data:'数据', privacy:'隐私',
        theme:'主题', light:'浅色', dark:'深色', system:'系统', contrast:'高对比度',
        fontSize:'字体大小', mute:'静音', volume:'音量', chime:'监视提示音',
        refresh:'刷新', clearPrefs:'清除偏好', storageUsed:'存储',
        locale:'语言', install:'安装', offline:'离线', close:'关闭', screenshot:'截图',
        exportLog:'导出日志' },
}

export function getLocale(): Locale { return (lsGet<Locale>('ft-locale', 'en') as Locale) || 'en' }
export function setLocale(l: Locale) { lsSet('ft-locale', l) }
export function t(key: string, locale?: Locale): string {
  const l = locale || getLocale()
  return DICTS[l]?.[key] || DICTS.en[key] || key
}
