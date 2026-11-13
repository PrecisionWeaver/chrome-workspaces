// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { MIN_POINTS, resourceChart } from './sparkline';

const points = (chart: SVGSVGElement, name: string) => chart.querySelector(`polyline.${name}`)!.getAttribute('points')!.split(' ');

describe('resourceChart', () => {
  it('draws nothing until there are enough samples to show a trend', () => {
    expect(MIN_POINTS).toBe(3);
    expect(resourceChart([1, 2], [1, 2])).toBeNull();
    expect(resourceChart([1, 2, 3], [1, 2])).toBeNull();
    expect(resourceChart([1, 2, 3], [1, 2, 3])).not.toBeNull();
  });

  it('draws nothing when the two series are out of step', () => {
    expect(resourceChart([1, 2, 3, 4], [1, 2, 3])).toBeNull();
  });

  it('draws CPU under memory, so the memory line stays on top', () => {
    const chart = resourceChart([1, 2, 3], [4, 5, 6])!;
    expect([...chart.querySelectorAll('polyline')].map((line) => line.getAttribute('class'))).toEqual(['cpu', 'mem']);
    for (const line of chart.querySelectorAll('polyline')) {
      expect(line.getAttribute('fill')).toBe('none');
      expect(line.getAttribute('vector-effect')).toBe('non-scaling-stroke');
    }
  });

  it('scales each line to its own range, so a leak shows whatever the base', () => {
    const chart = resourceChart([100, 150, 200], [1, 3, 2])!;
    // Memory climbs from the floor to the top; the points run left to right across the chart's width.
    expect(points(chart, 'mem')).toEqual(['0.0,15.0', '30.0,8.0', '60.0,1.0']);
    // CPU peaks in the middle, scaled to its own, much smaller, range.
    expect(points(chart, 'cpu')).toEqual(['0.0,15.0', '30.0,1.0', '60.0,8.0']);
  });

  it('sits a flat series mid-height rather than on the floor', () => {
    const chart = resourceChart([5, 5, 5], [0, 0, 0])!;
    expect(points(chart, 'mem').map((p) => p.split(',')[1])).toEqual(['8.0', '8.0', '8.0']);
  });

  it('is decoration: hidden from assistive technology, sized to its box, and classed as asked', () => {
    const chart = resourceChart([1, 2, 3], [1, 2, 3], 'in-list')!;
    expect(chart.getAttribute('aria-hidden')).toBe('true');
    expect(chart.getAttribute('viewBox')).toBe('0 0 60 16');
    expect(chart.getAttribute('class')).toBe('resource-chart in-list');
    expect(resourceChart([1, 2, 3], [1, 2, 3])!.getAttribute('class')).toBe('resource-chart');
  });
});
