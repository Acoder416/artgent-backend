interface PendingReservation {
  bytes: number;
  resolve: (release: () => void) => void;
}

export class InputMemoryBudget {
  private usedBytes = 0;
  private readonly queue: PendingReservation[] = [];

  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error('Input memory budget must be a positive integer');
    }
  }

  acquire(requestedBytes: number): Promise<() => void> {
    const normalized = Number.isFinite(requestedBytes)
      ? Math.max(0, Math.ceil(requestedBytes))
      : this.maxBytes;
    const bytes = Math.min(this.maxBytes, normalized);
    if (bytes === 0) return Promise.resolve(() => undefined);

    return new Promise((resolve) => {
      const reservation = { bytes, resolve };
      if (
        this.queue.length === 0 &&
        this.usedBytes + reservation.bytes <= this.maxBytes
      ) {
        this.grant(reservation);
      } else {
        this.queue.push(reservation);
      }
    });
  }

  private grant(reservation: PendingReservation): void {
    this.usedBytes += reservation.bytes;
    let released = false;
    reservation.resolve(() => {
      if (released) return;
      released = true;
      this.usedBytes = Math.max(0, this.usedBytes - reservation.bytes);
      this.drain();
    });
  }

  private drain(): void {
    while (
      this.queue.length > 0 &&
      this.usedBytes + this.queue[0].bytes <= this.maxBytes
    ) {
      this.grant(this.queue.shift()!);
    }
  }
}
