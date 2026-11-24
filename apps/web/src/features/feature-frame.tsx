import { FeatureVisual, getFeatureDemo } from "./visuals";

export function FeatureFrame({
  id,
  className,
  interactive = false,
}: {
  id: string;
  className?: string;
  interactive?: boolean;
}) {
  const Demo = interactive ? getFeatureDemo(id) : undefined;

  if (Demo) {
    return (
      <div className={className}>
        <Demo />
      </div>
    );
  }

  return (
    <div className={className ? `fx-frame ${className}` : "fx-frame"}>
      <FeatureVisual id={id} />
    </div>
  );
}

export function FeatureThumb({ id }: { id: string }) {
  return (
    <span className="fx-thumb" aria-hidden="true">
      <span className="fx-thumb-art">
        <FeatureVisual id={id} />
      </span>
    </span>
  );
}
