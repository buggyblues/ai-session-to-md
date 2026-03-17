export default function Toast({ message, type = 'success' }) {
  return (
    <div className={`toast ${type}`} aria-live="polite">
      {message}
    </div>
  );
}
