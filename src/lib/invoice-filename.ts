const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** A stable, filesystem-safe filename for PDFs rendered by this app. */
export function invoicePdfFilename(companyBranchName: string, issueDate: string): string {
  const branch =
    companyBranchName
      .trim()
      .replace(/&/g, ' and ')
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'Company';
  const match = /^(\d{4})-(\d{2})/.exec(issueDate);
  const monthIndex = match ? Number(match[2]) - 1 : -1;
  const month = MONTH_NAMES[monthIndex] ?? 'Unknown_Month';
  const year = match?.[1] ?? 'Unknown_Year';
  return `${branch}_Invoice_${month}_${year}.pdf`;
}
