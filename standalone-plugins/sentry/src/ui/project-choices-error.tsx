export function ProjectChoicesError({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) {
  if (!error) return null;

  return (
    <div>
      <p role="alert" className="sentry-error">
        {error}
      </p>
      <button type="button" onClick={onRetry}>
        Retry project choices
      </button>
    </div>
  );
}
