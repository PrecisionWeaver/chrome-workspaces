// Lays out a commit list as VS Code's source control graph does: one column per line of history,
// with a row of segments per commit to draw as an SVG.

export interface GraphCommit {
  sha: string;
  parents: readonly string[];
}

export interface GraphSegment {
  /** Columns, and heights from 0 (top of the row) to 1 (bottom); the node sits at 0.5. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Index of the line of history, for choosing a color. */
  color: number;
}

export interface GraphRow {
  /** Column of this commit's node. */
  node: number;
  nodeColor: number;
  /** Columns the row spans. */
  width: number;
  segments: GraphSegment[];
}

interface Lane {
  sha: string;
  color: number;
}

/** Commits must be newest first with children before parents, as `git log --topo-order` gives. */
export function layoutGraph(commits: readonly GraphCommit[]): GraphRow[] {
  let lanes: (Lane | null)[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const before = [...lanes];
    let node = lanes.findIndex((lane) => lane?.sha === commit.sha);
    if (node === -1) {
      node = lanes.indexOf(null);
      if (node === -1) node = lanes.length;
      lanes[node] = { sha: commit.sha, color: nextColor++ };
    }
    const nodeColor = lanes[node]!.color;
    const converging = lanes.flatMap((lane, i) => (lane?.sha === commit.sha && i !== node ? [i] : []));
    for (const i of converging) lanes[i] = null;

    // Where each parent continues: its existing line, else the node's own for the first, else a free column.
    const parentColumns: { column: number; color: number }[] = [];
    commit.parents.forEach((parent, index) => {
      const existing = lanes.findIndex((lane, i) => lane?.sha === parent && i !== node);
      if (existing !== -1) {
        parentColumns.push({ column: existing, color: lanes[existing]!.color });
      } else if (index === 0) {
        lanes[node] = { sha: parent, color: nodeColor };
        parentColumns.push({ column: node, color: nodeColor });
      } else {
        let free = lanes.indexOf(null);
        if (free === -1 || free === node) free = lanes.length;
        lanes[free] = { sha: parent, color: nextColor++ };
        parentColumns.push({ column: free, color: lanes[free]!.color });
      }
    });
    // A first parent that continues in another column frees the node's own.
    if (commit.parents.length === 0 || parentColumns[0]?.column !== node) lanes[node] = null;

    const segments: GraphSegment[] = [];
    before.forEach((lane, column) => {
      if (!lane) return;
      if (lane.sha === commit.sha) segments.push({ x1: column, y1: 0, x2: node, y2: 0.5, color: lane.color });
      else segments.push({ x1: column, y1: 0, x2: column, y2: 1, color: lane.color });
    });
    for (const { column, color } of parentColumns) segments.push({ x1: node, y1: 0.5, x2: column, y2: 1, color });

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ node, nodeColor, width: Math.max(before.length, lanes.length, node + 1), segments });
  }
  return rows;
}
