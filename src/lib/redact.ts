/** Remove bearer invoice capabilities before paths enter logs or alert email. */
export function redactSensitivePath(path: string): string {
  return path.replace(/\/pay\/[^/]+/g, '/pay/[REDACTED]');
}
