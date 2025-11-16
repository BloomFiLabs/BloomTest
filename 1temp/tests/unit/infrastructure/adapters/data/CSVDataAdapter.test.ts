import { describe, it, expect, beforeEach } from 'vitest';
import { CSVDataAdapter } from '@infrastructure/adapters/data/CSVDataAdapter';
import { Price, Amount } from '@domain/value-objects';
import * as fs from 'fs';
import * as path from 'path';

describe('CSVDataAdapter', () => {
  let adapter: CSVDataAdapter;
  const testDataDir = path.join(__dirname, '../../../../test-data');

  beforeEach(() => {
    adapter = new CSVDataAdapter(testDataDir);
  });

  it('should create adapter with data directory', () => {
    expect(adapter).toBeDefined();
  });

  it('should fetch price from CSV', async () => {
    // Create test CSV file
    const csvContent = `timestamp,open,high,low,close,volume
2024-01-01T00:00:00Z,2000,2100,1900,2050,1000000
2024-01-02T00:00:00Z,2050,2150,1950,2100,1200000`;

    const testFile = path.join(testDataDir, 'ETH-USDC.csv');
    if (!fs.existsSync(testDataDir)) {
      fs.mkdirSync(testDataDir, { recursive: true });
    }
    fs.writeFileSync(testFile, csvContent);

    const price = await adapter.fetchPrice('ETH-USDC', new Date('2024-01-01T00:00:00Z'));
    expect(price.value).toBe(2050); // Close price

    // Cleanup
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  });
});

