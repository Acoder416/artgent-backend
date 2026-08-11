import { InputMemoryBudget } from './input-memory-budget';

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('InputMemoryBudget', () => {
  it('queues weighted reservations until enough bytes are released', async () => {
    const budget = new InputMemoryBudget(10);
    const releaseFirst = await budget.acquire(7);
    let secondAcquired = false;
    const second = budget.acquire(4).then((release) => {
      secondAcquired = true;
      return release;
    });

    await nextTurn();
    expect(secondAcquired).toBe(false);

    releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
  });

  it('lets one oversized reservation consume the whole budget without deadlocking', async () => {
    const budget = new InputMemoryBudget(10);
    const release = await budget.acquire(100);
    release();
    await expect(budget.acquire(1)).resolves.toEqual(expect.any(Function));
  });
});
