"use client";
import type { ReactNode } from "react";
import { Keyboard } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import { SharingPanel, WorkspaceIdentity } from "@/features/agent-access";
import { NotificationSettingsView, type NotificationControl } from "@/features/handoffs";
import type { Device } from "@/shared/contracts/devices";
import ThemeSetting from "./ThemeSetting";

export type SettingsSection = "general" | "notifications" | "storage";
type Props = {
  section: SettingsSection; onSection: (section: SettingsSection) => void;
  displayName: string | null; deviceName: string | null;
  /** This browser's notification state and the registered devices it can be bound to. */
  notifications: NotificationControl; devices: readonly Device[]; currentDeviceId: string | null; notify: (text: string) => void;
  characters: boolean; onCharactersChange: (enabled: boolean) => void; onShowShortcuts: () => void;
  /** The setup checklist was hidden in this browser before setup ended; Settings is where it comes back. */
  setupHidden: boolean; onShowSetup: () => void;
  /** The storage manager, composed by the page because it depends on sample mode. */
  storage: ReactNode;
};

/** Preferences that are set once and rarely touched, kept out of the top bar. */
export default function SettingsView({ section, onSection, displayName, deviceName, notifications, devices, currentDeviceId, notify, characters, onCharactersChange, onShowShortcuts, setupHidden, onShowSetup, storage }: Props) {
  const { t, lang, setLang } = useLang(), s = t.settings;
  const sections: [SettingsSection, string][] = [["general", s.general], ["notifications", s.notifications], ["storage", s.storage]];
  return <section className="settings" data-section={section} aria-labelledby="settings-title">
    <header className="settings-head">
      <h1 id="settings-title">{s.title}</h1>
      <div className="segmented settings-tabs" role="group" aria-label={s.sections}>
        {sections.map(([value, label]) => <button key={value} type="button" data-settings-section={value} aria-pressed={section === value} onClick={() => onSection(value)}>{label}</button>)}
      </div>
    </header>
    {section === "storage" ? storage : section === "notifications" ? <div className="settings-general">
      <NotificationSettingsView control={notifications} devices={devices} currentDeviceId={currentDeviceId} notify={notify} />
    </div> : <div className="settings-general">
      <section className="setting-group" aria-labelledby="setting-general">
        <h2 id="setting-general">{s.general}</h2>
        <div className="setting-row">
          <div className="setting-text"><strong>{t.language}</strong><p>{s.languageNote}</p></div>
          <div className="lang-switch" role="group" aria-label={t.language} data-lang={lang}>
            <button aria-pressed={lang === "en"} lang="en" onClick={() => setLang("en")}>EN</button>
            <button aria-pressed={lang === "zh"} lang="zh-CN" onClick={() => setLang("zh")}>中文</button>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-text"><strong>{t.theme}</strong><p>{s.appearanceNote}</p></div>
          <ThemeSetting />
        </div>
      </section>
      <section className="setting-group" aria-labelledby="setting-keyboard">
        <h2 id="setting-keyboard">{s.keyboard}</h2>
        <label className="shortcut-setting"><input type="checkbox" checked={characters} onChange={event => onCharactersChange(event.target.checked)} />{t.shortcutsEnabled}</label>
        <p className="shortcut-note">{t.shortcutsSettingNote}</p>
        <button type="button" className="btn shortcuts-button" onClick={onShowShortcuts}><Keyboard size={16} aria-hidden="true" />{s.showShortcuts}</button>
      </section>
      <section className="setting-group" aria-labelledby="setting-workspace">
        <h2 id="setting-workspace">{s.workspace}</h2>
        <WorkspaceIdentity displayName={displayName} deviceName={deviceName} />
        {/* Sharing changes this workspace, so it sits with the workspace rather than with the agents. */}
        <SharingPanel notify={notify} />
        {setupHidden && <div className="setting-row">
          <div className="setting-text"><strong>{t.setup.title}</strong><p>{t.setup.hiddenNote}</p></div>
          <button type="button" className="btn" onClick={onShowSetup}>{t.setup.show}</button>
        </div>}
      </section>
    </div>}
  </section>;
}
