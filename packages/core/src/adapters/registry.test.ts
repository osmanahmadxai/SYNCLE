import { describe, expect, it } from 'vitest';
import { engineSchema } from '../validation';
import { bootstrapDrivers, listDrivers } from './index';

describe('engines and drivers', () => {
  bootstrapDrivers();
  const registered = listDrivers()
    .map((d) => d.engine)
    .sort();

  it('every engine a connection may have has a driver behind it', () => {
    // `mssql` sat in this list for a year with no adapter: a connection to it
    // could be saved, and then answered 501 to every single thing asked of it
    expect([...engineSchema.options].sort()).toEqual(registered);
  });

  it('is asked for twice without registering anything twice', () => {
    bootstrapDrivers();
    expect(
      listDrivers()
        .map((d) => d.engine)
        .sort(),
    ).toEqual(registered);
  });
});
