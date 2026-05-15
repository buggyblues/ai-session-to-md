import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'ai-session-display-settings';

export const DEFAULT_SETTINGS = {
  showUser: true,
  showAssistant: true,
  showThinking: true,
  showToolCalls: true,
  showToolResults: true,
};

export const SETTING_LABELS = {
  showUser: 'User messages',
  showAssistant: 'Assistant replies',
  showThinking: 'Thinking process',
  showToolCalls: 'Tool calls',
  showToolResults: 'Tool results',
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export default function useDisplaySettings() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  // Hydrate from localStorage after mount (avoids SSR / hydration issues)
  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  const updateSetting = useCallback((key, value) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return { settings, updateSetting, resetSettings };
}
