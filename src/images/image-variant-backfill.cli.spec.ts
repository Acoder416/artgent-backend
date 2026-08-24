import { parseImageVariantBackfillCommand } from './image-variant-backfill.cli';

describe('image variant backfill command', () => {
  it('defaults to a development dry-run', () => {
    expect(parseImageVariantBackfillCommand([], {})).toEqual({
      environment: 'development',
      options: {
        apply: false,
        afterId: undefined,
        batchSize: undefined,
        concurrency: undefined,
      },
    });
  });

  it('parses explicit production apply controls', () => {
    expect(
      parseImageVariantBackfillCommand(
        [
          '--env=production',
          '--apply',
          '--after-id=25',
          '--batch-size=10',
          '--concurrency=2',
        ],
        {},
      ),
    ).toEqual({
      environment: 'production',
      options: { apply: true, afterId: 25, batchSize: 10, concurrency: 2 },
    });
  });

  it.each(['--batch-size=-1', '--concurrency=1.5', '--unknown']) (
    'rejects unsafe option %s',
    (option) => {
      expect(() => parseImageVariantBackfillCommand([option], {})).toThrow();
    },
  );
});
