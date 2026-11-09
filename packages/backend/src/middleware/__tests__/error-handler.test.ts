import { describe, it, expect, vi, beforeEach } from 'vitest';
import { errorHandler } from '../error-handler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq(): any {
  return {};
}

function mockRes(): any {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('errorHandler', () => {
  let next: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    next = vi.fn();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('responds with 500 and error message for an Error instance', () => {
    const req = mockReq();
    const res = mockRes();
    const err = new Error('Something went wrong');

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Something went wrong' });
  });

  it('responds with 500 and generic message for a non-Error value', () => {
    const req = mockReq();
    const res = mockRes();

    errorHandler('plain string error', req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
  });

  it('responds with 500 and generic message for null', () => {
    const req = mockReq();
    const res = mockRes();

    errorHandler(null, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
  });

  it('logs the error to console.error', () => {
    const req = mockReq();
    const res = mockRes();
    const err = new Error('Test error');

    errorHandler(err, req, res, next);

    expect(consoleErrorSpy).toHaveBeenCalledWith('[error-handler]', err);
  });

  it('logs non-Error values to console.error', () => {
    const req = mockReq();
    const res = mockRes();

    errorHandler(42, req, res, next);

    expect(consoleErrorSpy).toHaveBeenCalledWith('[error-handler]', 42);
  });
});
