const NS = 'http://www.w3.org/2000/svg';
const WIDTH = 60;
const HEIGHT = 16;

/** Fewer points than this is a dot, not a trend. */
export const MIN_POINTS = 3;

/** A small line of `values`, oldest first, scaled between its own lowest and highest so a leak shows however large the base. */
export function sparkline(values: readonly number[], className = ''): SVGSVGElement | null {
  if (values.length < MIN_POINTS) return null;
  const low = Math.min(...values);
  const span = Math.max(...values) - low;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * WIDTH;
      // A flat series sits mid-height rather than on the floor.
      const y = span === 0 ? HEIGHT / 2 : HEIGHT - 1 - ((v - low) / span) * (HEIGHT - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
  svg.setAttribute('width', String(WIDTH));
  svg.setAttribute('height', String(HEIGHT));
  svg.setAttribute('class', `sparkline ${className}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', points);
  line.setAttribute('fill', 'none');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(line);
  return svg;
}
