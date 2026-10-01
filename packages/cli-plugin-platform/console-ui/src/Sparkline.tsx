import { type JSX, type MouseEvent, useId, useState } from 'react';

const WIDTH = 240;
const HEIGHT = 48;
const PAD = 3;

/** A single-series trend line: the title names the series, so it carries no legend. */
export function Sparkline({ values, label }: { values: number[]; label: string }): JSX.Element {
  const [hovered, setHovered] = useState<number | undefined>();
  const titleId = useId();
  const max = Math.max(...values, 1);
  const step = values.length <= 1 ? WIDTH : (WIDTH - PAD * 2) / (values.length - 1);
  const x = (index: number) => PAD + index * step;
  const y = (value: number) => HEIGHT - PAD - (value / max) * (HEIGHT - PAD * 2);
  const line = values.map((value, index) => `${x(index)},${y(value)}`).join(' ');
  const area = `${x(0)},${HEIGHT - PAD} ${line} ${x(values.length - 1)},${HEIGHT - PAD}`;
  const focus = hovered ?? values.length - 1;
  const focused = values[focus];

  function track(event: MouseEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width === 0) return;
    const position = ((event.clientX - bounds.left) / bounds.width) * WIDTH;
    const index = Math.round((position - PAD) / step);
    setHovered(Math.min(values.length - 1, Math.max(0, index)));
  }

  return (
    <div>
      <svg
        className="console-sparkline"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-labelledby={titleId}
        onMouseMove={track}
        onMouseLeave={() => setHovered(undefined)}
      >
        <title id={titleId}>{label}</title>
        <polygon className="console-sparkline__area" points={area} />
        <polyline className="console-sparkline__line" points={line} />
        {focused === undefined ? null : (
          <circle className="console-sparkline__marker" cx={x(focus)} cy={y(focused)} r={4} />
        )}
      </svg>
      <div className="console-metric" aria-live="polite">
        {hovered === undefined
          ? `Latest ${focused ?? 0} · peak ${Math.max(...values, 0)}`
          : `Sample ${hovered + 1} of ${values.length}: ${focused ?? 0}`}
      </div>
    </div>
  );
}
