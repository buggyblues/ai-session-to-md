import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { SETTING_LABELS } from '../hooks/useDisplaySettings';

export default function DisplaySettings({ settings, onUpdate, onReset }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  // Anchor the panel to the button using fixed positioning so it escapes
  // any ancestor `overflow: hidden` (which would otherwise clip it).
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const update = () => {
      const r = btnRef.current.getBoundingClientRect();
      setPos({
        top: r.bottom + 6,
        right: Math.max(8, window.innerWidth - r.right),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  // Close when clicking outside / pressing Escape
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      const inBtn = btnRef.current && btnRef.current.contains(e.target);
      const inPanel = panelRef.current && panelRef.current.contains(e.target);
      if (!inBtn && !inPanel) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hiddenCount = Object.values(settings).filter((v) => !v).length;

  const panel = open ? (
    <div
      ref={panelRef}
      className="display-settings-panel"
      role="dialog"
      aria-label="Display settings"
      style={{ position: 'fixed', top: pos.top, right: pos.right }}
    >
      <div className="display-settings-header">
        <strong>Show / hide content</strong>
        <button
          type="button"
          className="display-settings-reset"
          onClick={onReset}
        >
          Reset
        </button>
      </div>
      <p className="display-settings-hint">
        Applies to both the viewer and exported Markdown (.md / copy).
      </p>
      <ul className="display-settings-list">
        {Object.keys(SETTING_LABELS).map((key) => (
          <li key={key}>
            <label>
              <input
                type="checkbox"
                checked={!!settings[key]}
                onChange={(e) => onUpdate(key, e.target.checked)}
              />
              <span>{SETTING_LABELS[key]}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  return (
    <div className="display-settings">
      <button
        ref={btnRef}
        className="btn btn-secondary"
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Display settings"
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M8 1v2M8 13v2M15 8h-2M3 8H1M12.95 3.05l-1.41 1.41M4.46 11.54l-1.41 1.41M12.95 12.95l-1.41-1.41M4.46 4.46L3.05 3.05"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        Display
        {hiddenCount > 0 && (
          <span className="display-settings-badge" aria-label={`${hiddenCount} hidden`}>
            {hiddenCount}
          </span>
        )}
      </button>
      {panel && createPortal(panel, document.body)}
    </div>
  );
}
