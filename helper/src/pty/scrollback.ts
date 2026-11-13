export class Scrollback {
  private chunks: string[] = [];
  private length = 0;

  constructor(private readonly limit: number) {}

  push(data: string): void {
    this.chunks.push(data);
    this.length += data.length;

    while (this.length > this.limit) {
      const head = this.chunks[0];
      const excess = this.length - this.limit;
      if (head.length <= excess) {
        this.chunks.shift();
        this.length -= head.length;
      } else {
        this.chunks[0] = head.slice(excess);
        this.length -= excess;
      }
    }
  }

  snapshot(): string {
    return this.chunks.join('');
  }
}
