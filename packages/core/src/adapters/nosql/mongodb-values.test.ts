/**
 * BSON values become plain JavaScript ones at the adapter boundary, and a
 * field's sampled type reflects every document seen, not just the first.
 */
import { describe, expect, it } from 'vitest';
import {
  Binary,
  Decimal128,
  Double,
  Int32,
  Long,
  ObjectId,
  Timestamp,
  UUID,
} from 'mongodb';
import type { ConnectionConfig } from '../types';
import {
  mergeSampledType,
  mongoTunnelOptions,
  normalizeMongoDocument,
  stripLineComments,
  normalizeMongoValue,
} from './mongodb-adapter';

describe('normalizeMongoValue', () => {
  it('an ObjectId is its hex string', () => {
    expect(normalizeMongoValue(new ObjectId('507f1f77bcf86cd799439011'))).toBe(
      '507f1f77bcf86cd799439011',
    );
  });

  it('a Decimal128 keeps every digit', () => {
    const v = Decimal128.fromString('12345678901234567890.123456789');
    expect(normalizeMongoValue(v)).toBe('12345678901234567890.123456789');
  });

  it('a Long is a number only when that is exact', () => {
    expect(normalizeMongoValue(Long.fromNumber(42))).toBe(42);
    expect(normalizeMongoValue(Long.fromString('9007199254740993'))).toBe(
      '9007199254740993',
    );
    expect(normalizeMongoValue(Long.fromString('-9223372036854775808'))).toBe(
      '-9223372036854775808',
    );
  });

  it('Int32 and Double are numbers', () => {
    expect(normalizeMongoValue(new Int32(7))).toBe(7);
    expect(normalizeMongoValue(new Double(0.5))).toBe(0.5);
  });

  it('a Binary is bytes, and a UUID-subtype Binary is a UUID string', () => {
    const bytes = normalizeMongoValue(new Binary(Buffer.from('00ff10', 'hex')));
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect((bytes as Buffer).toString('hex')).toBe('00ff10');
    const id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    expect(normalizeMongoValue(new UUID(id))).toBe(id);
    expect(normalizeMongoValue(new UUID(id).toBinary())).toBe(id);
  });

  it('a replication Timestamp is not mistaken for the Long it extends', () => {
    expect(normalizeMongoValue(new Timestamp({ t: 1, i: 2 }))).toBe(
      '4294967298',
    );
  });

  it('works at every depth, because a nested document lands in one json column', () => {
    const doc = normalizeMongoDocument({
      _id: new ObjectId('507f1f77bcf86cd799439011'),
      owner: {
        ref: new ObjectId('65f000000000000000000abc'),
        score: Decimal128.fromString('9.5'),
      },
      history: [{ at: new Date(0), n: new Int32(1) }, [Long.fromNumber(5)]],
    });
    expect(doc).toEqual({
      _id: '507f1f77bcf86cd799439011',
      owner: { ref: '65f000000000000000000abc', score: '9.5' },
      history: [{ at: new Date(0), n: 1 }, [5]],
    });
    // and the result survives JSON, which is where a json column puts it
    expect(() => JSON.stringify(doc)).not.toThrow();
  });

  it('leaves plain values, dates and buffers exactly as they are', () => {
    const at = new Date();
    const buf = Buffer.from('x');
    for (const v of [null, undefined, 'a', 1, true, at, buf]) {
      expect(normalizeMongoValue(v)).toBe(v);
    }
  });
});

describe('mergeSampledType', () => {
  it('a null first value does not decide the type', () => {
    expect(mergeSampledType(undefined, 'null')).toBe('null');
    expect(mergeSampledType('null', 'date')).toBe('date');
    expect(mergeSampledType('date', 'null')).toBe('date');
  });

  it('numbers widen to the widest kind seen', () => {
    expect(mergeSampledType('int', 'long')).toBe('long');
    expect(mergeSampledType('long', 'int')).toBe('long');
    expect(mergeSampledType('int', 'number')).toBe('number');
    expect(mergeSampledType('number', 'decimal128')).toBe('decimal128');
  });

  it('genuinely different kinds are reported as mixed', () => {
    expect(mergeSampledType('number', 'string')).toBe('mixed');
    expect(mergeSampledType('mixed', 'date')).toBe('mixed');
    expect(mergeSampledType('object', 'array')).toBe('mixed');
  });

  it('agreement changes nothing', () => {
    expect(mergeSampledType('string', 'string')).toBe('string');
  });
});

describe('mongoTunnelOptions', () => {
  const base = {
    id: 'c',
    name: 'c',
    engine: 'mongodb',
    host: '127.0.0.1',
    port: 40123,
  } as ConnectionConfig;

  it('pins the driver to the tunnelled address', () => {
    // rerouted through a tunnel: `tlsHostOverride` carries the real host name.
    // left to discover the replica set, the driver would go on to dial the
    // members by the names the SET knows them by — unreachable from this side
    expect(
      mongoTunnelOptions({ ...base, tlsHostOverride: 'mongo-0.internal' }),
    ).toEqual({
      directConnection: true,
    });
  });

  it('leaves an ordinary connection to discover its replica set', () => {
    expect(mongoTunnelOptions(base)).toEqual({});
  });

  it('leaves a connection string to say what it means', () => {
    expect(
      mongoTunnelOptions({
        ...base,
        tlsHostOverride: 'mongo-0.internal',
        connectionString: 'mongodb://a,b,c/?replicaSet=rs0',
      }),
    ).toEqual({});
  });
});

describe('stripLineComments', () => {
  it('lets the query editor’s own starter text run', () => {
    const starter =
      '// Write a JSON command and press Ctrl + Enter\n{\n  "collection": "users",\n  "find": {},\n  "limit": 20\n}';
    expect(JSON.parse(stripLineComments(starter))).toEqual({
      collection: 'users',
      find: {},
      limit: 20,
    });
  });

  it('only takes lines that START with //: a URL inside a value is data', () => {
    const doc =
      '  // indented comment\n{ "collection": "links", "find": { "url": "https://example.test//path" } }';
    expect(JSON.parse(stripLineComments(doc))).toEqual({
      collection: 'links',
      find: { url: 'https://example.test//path' },
    });
  });

  it('leaves a document without comments exactly as it was', () => {
    const doc = '{ "collection": "users" }';
    expect(stripLineComments(doc)).toBe(doc);
  });
});
