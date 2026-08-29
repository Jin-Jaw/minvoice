import { describe, expect, it } from 'vitest';
import { redactSensitivePath } from './redact';

describe('redactSensitivePath', () => {
  it('removes invoice capabilities while preserving the route shape', () => {
    expect(redactSensitivePath('/pay/abc123/pdf')).toBe('/pay/[REDACTED]/pdf');
    expect(redactSensitivePath('/pay/abc123')).toBe('/pay/[REDACTED]');
  });

  it('leaves non-capability paths useful for diagnostics', () => {
    expect(redactSensitivePath('/admin/invoices/12')).toBe('/admin/invoices/12');
  });
});
