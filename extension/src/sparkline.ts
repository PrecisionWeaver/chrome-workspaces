const NS = 'http://www.w3.org/2000/svg';
const WIDTH = 60;
const HEIGHT = 16;

/** Fewer points make a dot, not a trend. */
export const MIN_POINTS = 3;

/** A series as polyline points, scaled between its own lowest and highest so a leak shows whatever the base. */
function points(values: readonly number[]): string {
  const low = Math.min(...values);
  const span = Math.max(...values) - low;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * WIDTH;
      // A flat series sits mid-height rather than on the floor.
      const y = span === 0 ? HEIGHT / 2 : HEIGHT - 1 - ((v - low) / span) * (HEIGHT - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/**
 * Memory and CPU, oldest first, as two lines in one small chart. The units differ, so each line is scaled to its own
 * range: the chart shows how each moved, not how they compare. Null while there are too few samples to show a trend.
 */
export function resourceChart(memory: readonly number[], cpu: readonly number[], className = ''): SVGSVGElement | null {
  if (memory.length < MIN_POINTS || cpu.length < MIN_POINTS || memory.length !== cpu.length) return null;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
  svg.setAttribute('width', String(WIDTH));
  svg.setAttribute('height', String(HEIGHT));
  svg.setAttribute('class', `resource-chart ${className}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  // CPU first, so the memory line (the one with the amber warning) is drawn over it.
  for (const [name, values] of [
    ['cpu', cpu],
    ['mem', memory],
  ] as const) {
    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('class', name);
    line.setAttribute('points', points(values));
    line.setAttribute('fill', 'none');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(line);
  }
  return svg;
}
